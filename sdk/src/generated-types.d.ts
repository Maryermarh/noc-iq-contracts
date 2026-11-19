// AUTO-GENERATED — do not edit by hand.
// Regenerate with `npm run generate:types` from the live contract spec.

export interface GeneratedSLAConfig {
  threshold_minutes: number;
  penalty_per_minute: bigint;
  reward_base: bigint;
}

export declare function getConfig(severity: string): Promise<GeneratedSLAConfig>;
export declare function calculateSla(caller: string, outage_id: string, severity: string, mttr_minutes: number): Promise<unknown>;
