/**
 * Mock SLA Calculator Client
 *
 * A drop-in stand-in for SLACalculatorClient for use in web app unit
 * tests, so tests don't need a live RPC endpoint. Every public method on
 * SLACalculatorClient is inherited unchanged (they all funnel through the
 * single `invoke()` seam), and this subclass intercepts that seam to
 * return configured mock responses and record call history instead.
 */

import { SLACalculatorClient, ClientConfig, ContractResult } from "./client";
import { decodeContractError } from "./types";

export interface MockCallRecord {
  method: string;
  args: unknown[];
}

export interface MockResponse<T = unknown> {
  value?: T;
  error?: string;
}

export type MockRole = "admin" | "operator";

/**
 * Protected contract methods and the role the real contract requires of their first argument (the
 * caller). Mirrors the authorization checks in `sla_calculator/src/lib.rs` and the matrix in
 * `tests/authMatrix.test.ts`; `accept_admin` / `accept_operator` are checked against a pending
 * proposal, which the mock does not model.
 */
export const PROTECTED_METHODS: Readonly<Record<string, MockRole>> = {
  migrate: "admin",
  set_config: "admin",
  pause: "admin",
  unpause: "admin",
  prune_history: "admin",
  prune_history_by_age: "admin",
  set_retention_limit: "admin",
  propose_admin: "admin",
  cancel_admin_proposal: "admin",
  renounce_admin: "admin",
  set_operator: "admin",
  propose_operator: "admin",
  cancel_operator_proposal: "admin",
  calculate_sla: "operator",
};

/** The same result the generated client produces for contract error #3 (`Unauthorized`). */
function unauthorized<T>(): ContractResult<T> {
  const decoded = decodeContractError(3);
  return { ok: false, error: decoded.message, errorCode: decoded.name, contractErrorCode: decoded.code };
}

const DEFAULT_MOCK_CONFIG: ClientConfig = {
  contractId: "MOCK_CONTRACT_ID",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "mock://rpc",
};

/**
 * Mock client implementing the same public interface as
 * SLACalculatorClient (via inheritance), with configurable mock responses
 * and call-history tracking for test assertions.
 *
 * @example
 * ```ts
 * const client = new MockSlaCalculatorClient();
 * client.mockResponse("get_admin", { value: "GADMIN123" });
 * const result = await client.getAdmin();
 * expect(client.calls).toEqual([{ method: "get_admin", args: [] }]);
 * ```
 */
export class MockSlaCalculatorClient extends SLACalculatorClient {
  /** Ordered history of every contract method invoked on this mock. */
  readonly calls: MockCallRecord[] = [];

  private readonly responses = new Map<string, MockResponse>();

  /**
   * Admin/operator identities. Authorization is only enforced once they are known, either through
   * an `initialize(admin, operator)` call or {@link setRoles}; until then every call succeeds, as
   * before.
   */
  private roles: { admin: string; operator: string } | undefined;

  constructor(config: ClientConfig = DEFAULT_MOCK_CONFIG) {
    super(config);
  }

  /**
   * Configures the mock return value (or error) for a given contract
   * method name (e.g. "get_admin", "calculate_sla").
   */
  mockResponse<T>(method: string, response: MockResponse<T>): void {
    // Copied so later changes to the caller's object cannot alter this instance's configured response.
    this.responses.set(method, { ...(response as MockResponse) });
  }

  /**
   * Makes the mock enforce the contract's authorization rules for the given identities: protected
   * methods called by anyone else fail with the same `Unauthorized` error the real client reports.
   */
  setRoles(admin: string, operator: string): void {
    this.roles = { admin, operator };
  }

  /** Clears configured responses, recorded call history and the enforced roles. */
  reset(): void {
    this.responses.clear();
    this.calls.length = 0;
    this.roles = undefined;
  }

  /** Invokes a contract method by its contract name (used by the parity fixtures). */
  invokeMethod<T = unknown>(method: string, args: unknown[]): Promise<ContractResult<T>> {
    return this.invoke<T>(method, args);
  }

  protected async invoke<T>(
    method: string,
    args: unknown[],
  ): Promise<ContractResult<T>> {
    this.calls.push({ method, args });

    if (method === "initialize" && typeof args[0] === "string" && typeof args[1] === "string") {
      this.roles = { admin: args[0], operator: args[1] };
    }

    // The contract rejects an unauthorized caller before doing anything else, so the mock must too:
    // an unauthenticated flow cannot succeed here and then fail against the real contract.
    const required = PROTECTED_METHODS[method];
    if (this.roles && required && args[0] !== this.roles[required]) {
      return unauthorized<T>();
    }

    const configured = this.responses.get(method);
    if (configured) {
      if (configured.error !== undefined) {
        return { ok: false, error: configured.error };
      }
      return { ok: true, value: configured.value as T };
    }

    return super.invoke<T>(method, args);
  }
}
