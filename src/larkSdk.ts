import { LarkChannel, LarkChannelOptions } from "@larksuiteoapi/node-sdk";

export function createLarkChannel(options: LarkChannelOptions): LarkChannel {
  return new LarkChannel(options);
}
