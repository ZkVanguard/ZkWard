/**
 * @zkward/hedera-graphql-adapter — serve any Hedera contract as a
 * standardized GraphQL / subgraph endpoint.
 *
 *   import { createHederaGraphQLAdapter } from '@zkward/hedera-graphql-adapter';
 *
 *   const adapter = createHederaGraphQLAdapter({
 *     network: 'testnet',
 *     contract: '0xe7E6…9A9',
 *     preset: 'erc4626',
 *   });
 *
 *   // In any Node HTTP handler:
 *   const { data, extensions } = await adapter.execute({
 *     query: '{ pools { id totalNav memberCount } }',
 *   });
 *
 * Bridges Hedera Mirror Node into the same query shape a Messari-style
 * subgraph on The Graph exposes — so all Graph-native tooling (MCP,
 * playgrounds, GraphiQL) works over Hedera contracts without waiting
 * for The Graph to add Hedera support natively.
 */

import { buildSchema, execute, parse, validate, type GraphQLFieldResolver } from 'graphql';
import { MirrorClient } from './mirror';
import { SHARED_TYPEDEFS } from './schema/shared';
import { createErc4626Preset } from './schema/erc4626';
import { attestOnHcs } from './attestation';
import type {
  Adapter,
  AdapterConfig,
  ExecuteInput,
  ExecuteResult,
} from './types';

export * from './types';
export { canonicalHash, stableStringify } from './attestation';
export { MirrorClient } from './mirror';
export { normalizeLog, topicToAddress, decodeUint } from './events';
export { ERC4626_TOPICS, ERC4626_SELECTORS } from './schema/erc4626';

function attachResolvers(
  s: ReturnType<typeof buildSchema>,
  r: Record<string, Record<string, GraphQLFieldResolver<unknown, unknown>>>,
): void {
  for (const [typeName, fields] of Object.entries(r)) {
    const t = s.getType(typeName);
    if (!t || !('getFields' in t)) continue;
    const typeFields = (t as unknown as { getFields: () => Record<string, { resolve?: unknown }> }).getFields();
    for (const [fieldName, fn] of Object.entries(fields)) {
      if (typeFields[fieldName]) typeFields[fieldName].resolve = fn;
    }
  }
}

export function createHederaGraphQLAdapter(config: AdapterConfig): Adapter {
  const client = new MirrorClient({
    network: config.network,
    base: config.mirrorNodeBase,
  });

  const preset = config.preset ?? 'auto';
  // v0.1 ships erc4626 + auto (aliased to erc4626). Custom preset landing
  // in v0.2 — noted in DESIGN.md.
  if (preset === 'custom') {
    throw new Error("preset: 'custom' is planned for v0.2 — use 'erc4626' or 'auto' for now");
  }

  const impl = createErc4626Preset({
    client,
    contract: config.contract,
    network: config.network,
  });

  const schema = buildSchema(SHARED_TYPEDEFS);
  attachResolvers(schema, impl.resolvers as Parameters<typeof attachResolvers>[1]);

  return {
    async execute<T = unknown>(input: ExecuteInput): Promise<ExecuteResult<T>> {
      const doc = parse(input.query);
      const errs = validate(schema, doc);
      if (errs.length > 0) {
        return { errors: errs.map((e) => ({ message: e.message })) };
      }
      const raw = await execute({
        schema,
        document: doc,
        variableValues: input.variables ?? undefined,
        operationName: input.operationName ?? undefined,
      });

      const result: ExecuteResult<T> = {
        data: raw.data as T | undefined,
        errors: raw.errors?.map((e) => ({ message: e.message })),
      };

      if (input.attest && config.attestation) {
        const att = await attestOnHcs({
          config: config.attestation,
          network: config.network,
          queryPreview: input.query,
          data: raw.data,
          indexer: `hedera-graphql-adapter:${config.contract.toLowerCase()}`,
        });
        result.extensions = { _attestation: att };
      }

      return result;
    },
    getSchemaSDL(): string {
      return SHARED_TYPEDEFS;
    },
    getConfig(): Readonly<AdapterConfig> {
      return Object.freeze({ ...config });
    },
  };
}
