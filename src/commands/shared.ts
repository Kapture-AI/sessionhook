import { BrokerClient } from "../client.js";
import { resolvePaths } from "../paths.js";

export function brokerClient(): BrokerClient {
  return new BrokerClient(resolvePaths(process.env).socketFile);
}
