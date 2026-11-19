/**
 * NOC IQ SLA Calculator — Offchain TypeScript SDK
 *
 * Typed async client for interacting with the SLA Calculator Soroban contract.
 * Provides ergonomic wrappers for all public contract methods.
 */

export {
  SLACalculatorClient,
  TimeoutError,
  decodeContractEvent,
  CANCELLED_ERROR_CODE,
  EMPTY_ERROR_RESPONSE_CODE,
  MALFORMED_RESPONSE_ERROR_CODE,
} from "./client";
export {
  CursorValidationError,
  MAX_CURSOR_LENGTH,
  validateCursor,
  encodeHistoryRequest,
  decodeHistoryRequest,
} from "./cursor";
export type { HistoryRequest } from "./cursor";
export type {
  ClientConfig,
  ContractResult,
  AbortSignalLike,
  HeadersLike,
  RpcRequest,
  RpcResponse,
  Transport,
  RetryPolicy,
  PreflightResult,
  ContractEvent,
  ContractEventCallback,
  TransactionStatus,
  TransactionStatusResult,
} from "./client";
export { toScVal, fromScVal, ScValRangeError } from "./scval";
export { generateTypeDefinitions, MissingEventSchemaError } from "./typegen";
export type { TypeGenSpec, TypeGenEvent } from "./typegen";
export type { ScVal, ScValType } from "./scval";
export {
  CANONICAL_SEVERITIES,
  MAX_HISTORY_SIZE,
  decodeContractError,
} from "./types";
export type {
  SLAConfig,
  SLAConfigEntry,
  SLAConfigSnapshot,
  SLAResult,
  SLAResultSchema,
  SLAStats,
  ContractMetadata,
  PauseInfo,
  StorageVersionInfo,
  FailureCode,
  FailureSchema,
  VersionInfo,
  Severity,
  DecodedContractError,
} from "./types";
