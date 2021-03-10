import { arrayContentEquals } from '@cosmjs/utils';

import { Order, Packet, State } from '../codec/ibc/core/channel/v1/channel';
import { Height } from '../codec/ibc/core/client/v1/client';

import {
  AckWithMetadata,
  Endpoint,
  PacketWithMetadata,
  QueryOpts,
} from './endpoint';
import {
  buildCreateClientArgs,
  ChannelInfo,
  IbcClient,
  prepareChannelHandshake,
  prepareConnectionHandshake,
} from './ibcclient';
import { Logger, NoopLogger } from './logger';
import {
  parseAcksFromLogs,
  timestampFromDateNanos,
  toIntHeight,
} from './utils';

/**
 * Many actions on link focus on a src and a dest. Rather than add two functions,
 * we have `Side` to select if we initialize from A or B.
 */
export type Side = 'A' | 'B';

export function otherSide(side: Side): Side {
  if (side === 'A') {
    return 'B';
  } else {
    return 'A';
  }
}

// This records the block heights from the last point where we successfully relayed packets.
// This can be used to optimize the next round of relaying
export interface RelayedHeights {
  packetHeighA?: number;
  packetHeightB?: number;
  ackHeightA?: number;
  ackHeightB?: number;
}

// measured in seconds
// Note: client parameter is checked against the actual keeper - must use real values from genesis.json
// TODO: make this more adaptable for chains (query from staking?)
const genesisUnbondingTime = 1814400;

/**
 * Link represents a Connection between a pair of blockchains (Nodes).
 * An initialized Link requires a both sides to have a Client for the remote side
 * as well as an established Connection using those Clients. Channels can be added
 * and removed to a Link. There are constructors to find/create the basic requirements
 * if you don't know the client/connection IDs a priori.
 */
export class Link {
  public readonly endA: Endpoint;
  public readonly endB: Endpoint;
  public readonly logger: Logger;

  /**
   * findConnection attempts to reuse an existing Client/Connection.
   * If none exists, then it returns an error.
   *
   * @param nodeA
   * @param nodeB
   */
  public static async createWithExistingConnections(
    nodeA: IbcClient,
    nodeB: IbcClient,
    connA: string,
    connB: string,
    logger?: Logger
  ): Promise<Link> {
    const [
      { connection: connectionA },
      { connection: connectionB },
    ] = await Promise.all([
      nodeA.query.ibc.connection.connection(connA),
      nodeB.query.ibc.connection.connection(connB),
    ]);
    if (!connectionA) {
      throw new Error(`Connection not found for ID ${connA}`);
    }
    if (!connectionB) {
      throw new Error(`Connection not found for ID ${connB}`);
    }
    if (!connectionA.counterparty) {
      throw new Error(`Counterparty not found for connection with ID ${connA}`);
    }
    if (!connectionB.counterparty) {
      throw new Error(`Counterparty not found for connection with ID ${connB}`);
    }
    // ensure the connection is open
    if (connectionA.state != State.STATE_OPEN) {
      throw new Error(
        `Connection A must be in state open, it has state ${connectionA.state}`
      );
    }
    if (connectionB.state != State.STATE_OPEN) {
      throw new Error(
        `Connection B must be in state open, it has state ${connectionB.state}`
      );
    }

    const [clientIdA, clientIdB] = [connectionA.clientId, connectionB.clientId];
    if (clientIdA !== connectionB.counterparty.clientId) {
      throw new Error(
        `Client ID ${connectionA.clientId} for connection with ID ${connA} does not match counterparty client ID ${connectionB.counterparty.clientId} for connection with ID ${connB}`
      );
    }
    if (clientIdB !== connectionA.counterparty.clientId) {
      throw new Error(
        `Client ID ${connectionB.clientId} for connection with ID ${connB} does not match counterparty client ID ${connectionA.counterparty.clientId} for connection with ID ${connA}`
      );
    }
    const [chainIdA, chainIdB, clientStateA, clientStateB] = await Promise.all([
      nodeA.getChainId(),
      nodeB.getChainId(),
      nodeA.query.ibc.client.stateTm(clientIdA),
      nodeB.query.ibc.client.stateTm(clientIdB),
    ]);
    if (chainIdA !== clientStateB.chainId) {
      throw new Error(
        `Chain ID ${chainIdA} for connection with ID ${connA} does not match remote chain ID ${clientStateA.chainId}`
      );
    }
    if (chainIdB !== clientStateA.chainId) {
      throw new Error(
        `Chain ID ${chainIdB} for connection with ID ${connB} does not match remote chain ID ${clientStateB.chainId}`
      );
    }

    const endA = new Endpoint(nodeA, clientIdA, connA);
    const endB = new Endpoint(nodeB, clientIdB, connB);
    const link = new Link(endA, endB, logger);

    await Promise.all([
      link.assertHeadersMatchConsensusState(
        'A',
        clientIdA,
        clientStateA.latestHeight
      ),
      link.assertHeadersMatchConsensusState(
        'B',
        clientIdB,
        clientStateB.latestHeight
      ),
    ]);

    return link;
  }

  /**
   * we do this assert inside createWithExistingConnections, but it could be a useful check
   * for submitting double-sign evidence later
   *
   * @param proofSide the side holding the consensus proof, we check the header from the other side
   * @param height the height of the consensus state and header we wish to compare
   */
  public async assertHeadersMatchConsensusState(
    proofSide: Side,
    clientId: string,
    height?: Height
  ): Promise<void> {
    const { src, dest } = this.getEnds(proofSide);

    // Check headers match consensus state (at least validators)
    const [consensusState, header] = await Promise.all([
      src.client.query.ibc.client.consensusStateTm(clientId, height),
      dest.client.header(toIntHeight(height)),
    ]);
    // ensure consensus and headers match for next validator hashes
    if (
      !arrayContentEquals(
        consensusState.nextValidatorsHash,
        header.nextValidatorsHash
      )
    ) {
      throw new Error(`NextValidatorHash doesn't match ConsensusState.`);
    }
    // ensure the committed apphash matches the actual node we have
    const hash = consensusState.root?.hash;
    if (!hash) {
      throw new Error(`ConsensusState.root.hash missing.`);
    }
    if (!arrayContentEquals(hash, header.appHash)) {
      throw new Error(`AppHash doesn't match ConsensusState.`);
    }
  }

  /**
   * createConnection will always create a new pair of clients and a Connection between the
   * two sides
   *
   * @param nodeA
   * @param nodeB
   */
  public static async createWithNewConnections(
    nodeA: IbcClient,
    nodeB: IbcClient,
    logger?: Logger
  ): Promise<Link> {
    const [clientIdA, clientIdB] = await createClients(nodeA, nodeB);

    // connectionInit on nodeA
    const { connectionId: connIdA } = await nodeA.connOpenInit(
      clientIdA,
      clientIdB
    );

    // connectionTry on nodeB
    const proof = await prepareConnectionHandshake(
      nodeA,
      nodeB,
      clientIdA,
      clientIdB,
      connIdA
    );
    const { connectionId: connIdB } = await nodeB.connOpenTry(clientIdB, proof);

    // connectionAck on nodeA
    const proofAck = await prepareConnectionHandshake(
      nodeB,
      nodeA,
      clientIdB,
      clientIdA,
      connIdB
    );
    await nodeA.connOpenAck(connIdA, proofAck);

    // connectionConfirm on dest
    const proofConfirm = await prepareConnectionHandshake(
      nodeA,
      nodeB,
      clientIdA,
      clientIdB,
      connIdA
    );
    await nodeB.connOpenConfirm(proofConfirm);

    const endA = new Endpoint(nodeA, clientIdA, connIdA);
    const endB = new Endpoint(nodeB, clientIdB, connIdB);
    return new Link(endA, endB, logger);
  }

  // you can use this if you already have the info out of bounds
  // TODO; check the validity of that data?
  public constructor(endA: Endpoint, endB: Endpoint, logger?: Logger) {
    this.endA = endA;
    this.endB = endB;
    this.logger = logger ?? new NoopLogger();
  }

  /**
   * Writes the latest header from the sender chain to the other endpoint
   *
   * @param sender Which side we get the header/commit from
   * @returns header height (from sender) that is now known on dest
   *
   * Relayer binary should call this from a heartbeat which checks if needed and updates.
   * Just needs trusting period on both side
   */
  public async updateClient(sender: Side): Promise<Height> {
    this.logger.info(`Update client for sender ${sender}`);
    const { src, dest } = this.getEnds(sender);
    const height = await dest.client.doUpdateClient(dest.clientID, src.client);
    return height;
  }

  /**
   * Checks if the last proven header on the destination is older than maxAge,
   * and if so, update the client. Returns the new client height if updated,
   * or null if no update needed
   *
   * @param sender
   * @param maxAge
   */
  public async updateClientIfStale(
    sender: Side,
    maxAge: number
  ): Promise<Height | null> {
    // TODO: test this
    this.logger.info(
      `Checking if ${otherSide(sender)} has recent header of ${sender}`
    );
    const { src, dest } = this.getEnds(sender);
    const knownHeader = await dest.client.query.ibc.client.consensusStateTm(
      dest.clientID
    );
    const currentHeader = await src.client.latestHeader();

    // quit now if we don't need to update
    const knownSeconds = knownHeader.timestamp?.seconds?.toNumber();
    if (knownSeconds) {
      const curSeconds = timestampFromDateNanos(
        currentHeader.time
      ).seconds.toNumber();
      if (curSeconds - knownSeconds < maxAge) {
        return null;
      }
    }

    // otherwise, do the update
    return this.updateClient(sender);
  }

  /**
   * Ensures the dest has a proof of at least minHeight from source.
   * Will not execute any tx if not needed.
   * Will wait a block if needed until the header is available.
   *
   * Returns the latest header height now available on dest
   */
  public async updateClientToHeight(
    source: Side,
    minHeight: number
  ): Promise<Height> {
    this.logger.info(
      `Check whether client for source ${source} >= height ${minHeight}`
    );
    const { src, dest } = this.getEnds(source);
    const client = await dest.client.query.ibc.client.stateTm(dest.clientID);
    // TODO: revisit where revision number comes from - this must be the number from the source chain
    const knownHeight = client.latestHeight?.revisionHeight?.toNumber() ?? 0;
    if (knownHeight >= minHeight && client.latestHeight !== undefined) {
      return client.latestHeight;
    }

    const curHeight = (await src.client.latestHeader()).height;
    if (curHeight < minHeight) {
      await src.client.waitOneBlock();
    }
    return this.updateClient(source);
  }

  public async createChannel(
    sender: Side,
    srcPort: string,
    destPort: string,
    ordering: Order,
    version: string
  ): Promise<ChannelPair> {
    this.logger.info(
      `Create channel with sender ${sender}: ${srcPort} => ${destPort}`
    );
    const { src, dest } = this.getEnds(sender);
    // init on src
    const { channelId: channelIdSrc } = await src.client.channelOpenInit(
      srcPort,
      destPort,
      ordering,
      src.connectionID,
      version
    );

    // try on dest
    const proof = await prepareChannelHandshake(
      src.client,
      dest.client,
      dest.clientID,
      srcPort,
      channelIdSrc
    );

    const { channelId: channelIdDest } = await dest.client.channelOpenTry(
      destPort,
      { portId: srcPort, channelId: channelIdSrc },
      ordering,
      src.connectionID,
      version,
      version,
      proof
    );

    // ack on src
    const proofAck = await prepareChannelHandshake(
      dest.client,
      src.client,
      src.clientID,
      destPort,
      channelIdDest
    );
    await src.client.channelOpenAck(
      srcPort,
      channelIdSrc,
      channelIdDest,
      version,
      proofAck
    );

    // confirm on dest
    const proofConfirm = await prepareChannelHandshake(
      src.client,
      dest.client,
      dest.clientID,
      srcPort,
      channelIdSrc
    );
    await dest.client.channelOpenConfirm(destPort, channelIdDest, proofConfirm);

    return {
      src: {
        portId: srcPort,
        channelId: channelIdSrc,
      },
      dest: {
        portId: destPort,
        channelId: channelIdDest,
      },
    };
  }

  /**
   * This will check both sides for pending packets and relay them.
   * It will then relay all acks (previous and generated by the just-submitted packets).
   *
   * Returns the most recent heights it relay, which can be used as a start for the next round
   *
   * TODO: support handling timeouts once https://github.com/confio/ts-relayer/pull/90 is merged
   */
  public async checkAndRelayPacketsAndAcks(
    relayFrom: RelayedHeights
  ): Promise<RelayedHeights> {
    // TODO: get the packet height from this somehow
    const [packetsA, packetsB] = await Promise.all([
      this.getPendingPackets('A', { minHeight: relayFrom.packetHeighA }),
      this.getPendingPackets('B', { minHeight: relayFrom.packetHeightB }),
    ]);

    // FIXME: use these acks first? Then query for others?
    await Promise.all([
      this.relayPackets('A', packetsA),
      this.relayPackets('B', packetsB),
    ]);

    const [acksA, acksB] = await Promise.all([
      this.getPendingAcks('A', { minHeight: relayFrom.ackHeightA }),
      this.getPendingAcks('B', { minHeight: relayFrom.ackHeightB }),
    ]);

    await Promise.all([this.relayAcks('A', acksA), this.relayAcks('B', acksB)]);

    // TODO return newer value from above queries
    return relayFrom;
  }

  public async getPendingPackets(
    source: Side,
    opts: QueryOpts = {}
  ): Promise<PacketWithMetadata[]> {
    this.logger.verbose(`Get pending packets for source ${source}`);
    const { src, dest } = this.getEnds(source);
    const allPackets = await src.querySentPackets(opts);

    const toFilter = allPackets.map(({ packet }) => packet);
    const query = async (
      port: string,
      channel: string,
      sequences: readonly number[]
    ) => {
      const res = await dest.client.query.ibc.channel.unreceivedPackets(
        port,
        channel,
        sequences
      );
      return res.sequences.map((seq) => seq.toNumber());
    };
    const unreceived = await this.filterUnreceived(toFilter, query, packetId);

    return allPackets.filter(({ packet }) =>
      unreceived[packetId(packet)].has(packet.sequence.toNumber())
    );
  }

  public async getPendingAcks(
    source: Side,
    opts: QueryOpts = {}
  ): Promise<AckWithMetadata[]> {
    this.logger.verbose(`Get pending acks for source ${source}`);
    const { src, dest } = this.getEnds(source);
    const allAcks = await src.queryWrittenAcks(opts);

    const toFilter = allAcks.map(({ originalPacket }) => originalPacket);
    const query = async (
      port: string,
      channel: string,
      sequences: readonly number[]
    ) => {
      const res = await dest.client.query.ibc.channel.unreceivedAcks(
        port,
        channel,
        sequences
      );
      return res.sequences.map((seq) => seq.toNumber());
    };
    const unreceived = await this.filterUnreceived(toFilter, query, ackId);

    return allAcks.filter(({ originalPacket: packet }) =>
      unreceived[ackId(packet)].has(packet.sequence.toNumber())
    );
  }

  private async filterUnreceived(
    packets: Packet[],
    unreceivedQuery: (
      port: string,
      channel: string,
      sequences: readonly number[]
    ) => Promise<number[]>,
    idFunc: (packet: Packet) => string
  ): Promise<Record<string, Set<number>>> {
    if (packets.length === 0) {
      return {};
    }

    const packetsPerDestination = packets.reduce(
      (sorted: Record<string, readonly number[]>, packet) => {
        const key = idFunc(packet);
        return {
          ...sorted,
          [key]: [...(sorted[key] ?? []), packet.sequence.toNumber()],
        };
      },
      {}
    );
    const unreceivedResponses = await Promise.all(
      Object.entries(packetsPerDestination).map(
        async ([destination, sequences]) => {
          const [port, channel] = destination.split(idDelim);
          const notfound = await unreceivedQuery(port, channel, sequences);
          return { key: destination, sequences: notfound };
        }
      )
    );
    const unreceived = unreceivedResponses.reduce(
      (nested: Record<string, Set<number>>, { key, sequences }) => {
        return {
          ...nested,
          [key]: new Set(sequences),
        };
      },
      {}
    );
    return unreceived;
  }

  // Returns the last height that this side knows of the other blockchain
  public async lastKnownHeader(side: Side): Promise<number> {
    this.logger.verbose(`Get last known header for side ${side}`);
    const { src } = this.getEnds(side);
    const client = await src.client.query.ibc.client.stateTm(src.clientID);
    return client.latestHeight?.revisionHeight?.toNumber() ?? 0;
  }

  // this will update the client if needed and relay all provided packets from src -> dest
  // if packets are all older than the last consensusHeight, then we don't update the client.
  //
  // Returns all the acks that are associated with the just submitted packets
  public async relayPackets(
    source: Side,
    packets: readonly PacketWithMetadata[]
  ): Promise<AckWithMetadata[]> {
    this.logger.info(`Relay packets for source ${source}`);
    const { src, dest } = this.getEnds(source);

    // check if we need to update client at all
    const neededHeight = Math.max(...packets.map((x) => x.height)) + 1;
    const headerHeight = await this.updateClientToHeight(source, neededHeight);

    const submit = packets.map(({ packet }) => packet);
    const proofs = await Promise.all(
      submit.map((packet) => src.client.getPacketProof(packet, headerHeight))
    );
    const { logs, height } = await dest.client.receivePackets(
      submit,
      proofs,
      headerHeight
    );
    const acks = parseAcksFromLogs(logs);
    return acks.map((ack) => ({ height, ...ack }));
  }

  // this will update the client if needed and relay all provided acks from src -> dest
  // (yes, dest is where the packet was sent, but the ack was written on src).
  // if acks are all older than the last consensusHeight, then we don't update the client.
  //
  // Returns the block height the acks were included in
  public async relayAcks(
    source: Side,
    acks: readonly AckWithMetadata[]
  ): Promise<number> {
    this.logger.info(`Relay acks for source ${source}`);
    const { src, dest } = this.getEnds(source);

    // check if we need to update client at all
    const neededHeight = Math.max(...acks.map((x) => x.height)) + 1;
    const headerHeight = await this.updateClientToHeight(source, neededHeight);

    const proofs = await Promise.all(
      acks.map((ack) => src.client.getAckProof(ack, headerHeight))
    );
    const { height } = await dest.client.acknowledgePackets(
      acks,
      proofs,
      headerHeight
    );
    return height;
  }

  private getEnds(src: Side): EndpointPair {
    if (src === 'A') {
      return {
        src: this.endA,
        dest: this.endB,
      };
    } else {
      return {
        src: this.endB,
        dest: this.endA,
      };
    }
  }
}

const idDelim = ':';
const packetId = (packet: Packet) =>
  `${packet.destinationPort}${idDelim}${packet.destinationChannel}`;
const ackId = (packet: Packet) =>
  `${packet.sourcePort}${idDelim}${packet.sourceChannel}`;

export interface EndpointPair {
  readonly src: Endpoint;
  readonly dest: Endpoint;
}

export interface ChannelPair {
  readonly src: ChannelInfo;
  readonly dest: ChannelInfo;
}

async function createClients(
  nodeA: IbcClient,
  nodeB: IbcClient
): Promise<string[]> {
  // client on B pointing to A
  const args = await buildCreateClientArgs(nodeA, genesisUnbondingTime, 5000);
  const { clientId: clientIdB } = await nodeB.createTendermintClient(
    args.clientState,
    args.consensusState
  );

  // client on A pointing to B
  const args2 = await buildCreateClientArgs(nodeB, genesisUnbondingTime, 5000);
  const { clientId: clientIdA } = await nodeA.createTendermintClient(
    args2.clientState,
    args2.consensusState
  );

  return [clientIdA, clientIdB];
}
