// Whether the stores Clinic serves from can be read. check() rejects when one cannot.
export interface ReadinessProbe {
  check(): Promise<void>;
}
