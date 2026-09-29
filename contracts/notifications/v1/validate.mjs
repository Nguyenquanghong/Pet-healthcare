import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";

export const MAX_BODY_BYTES = 16_384;
export const MAX_AVAILABILITY_BYTES = 1_048_576;
const schema = JSON.parse(readFileSync(new URL("./contract.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addSchema(schema);
const names = ["event", "ingestAck", "actorClaims", "availability", "error", "manualSendRequest", "manualSendResult"];
const validators = Object.fromEntries(names.map((name) => [name, ajv.getSchema(`${schema.$id}#/$defs/${name}`)]));

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

export function validateContract(name, value, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const validator = validators[name];
  if (!validator) throw new ContractError("BAD_CONTRACT", `Unknown contract ${name}`);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new ContractError("BAD_CONTRACT", "Body cannot be serialized"); }
  if (serialized === undefined) throw new ContractError("BAD_CONTRACT", "Body is missing");
  const limit = name === "availability" ? MAX_AVAILABILITY_BYTES : MAX_BODY_BYTES;
  if (Buffer.byteLength(serialized, "utf8") > limit) throw new ContractError("BAD_CONTRACT", `Body exceeds ${limit} bytes`);
  if (!validator(value)) throw new ContractError("BAD_CONTRACT", ajv.errorsText(validator.errors));
  if (name === "actorClaims" && (value.exp <= value.iat || value.exp <= nowSeconds || value.iat > nowSeconds + 30)) {
    throw new ContractError("UNAUTHORIZED", "Actor token is expired or has invalid lifetime");
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function eventPayloadHash(event) {
  validateContract("event", event);
  return createHash("sha256").update(stable(event)).digest("hex");
}
