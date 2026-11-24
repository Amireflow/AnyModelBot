import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { LocalExecutionNode, localTaskId, validateControlPlaneUrl } from "../src/execution-node/service.js";

describe("LocalExecutionNode", () => {
  let store: Store | undefined;
  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it("persists one stable workstation identity in the local database", () => {
    store = new Store(":memory:");
    const options = {
      store,
      tasks: {} as never,
      workspace: (botId: string) => `/tmp/workspaces/${botId}`,
      env: {},
    };
    const first = new LocalExecutionNode(options);
    const second = new LocalExecutionNode(options);
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("persists pause and makes revocation irreversible through the remote protocol", async () => {
    store = new Store(":memory:");
    const node = new LocalExecutionNode({ store, tasks: {} as never, workspace: () => "/tmp/workspace", env: {} });
    node.pause();
    expect(node.status().state).toBe("paused");
    expect(node.resume()).toBe(true);
    expect(node.status().state).toBe("active");
    await node.revoke();
    expect(node.status().state).toBe("revoked");
    expect(node.resume()).toBe(false);
  });

  it("allows only TLS Control Plane URLs except loopback development", () => {
    expect(validateControlPlaneUrl("wss://control.example.test/node").protocol).toBe("wss:");
    expect(validateControlPlaneUrl("ws://127.0.0.1:8787/node").hostname).toBe("127.0.0.1");
    expect(() => validateControlPlaneUrl("ws://control.example.test/node")).toThrow(/wss/);
    expect(() => validateControlPlaneUrl("https://control.example.test/node")).toThrow(/WebSocket/);
    expect(() => validateControlPlaneUrl("wss://user:pass@control.example.test/node")).toThrow(/credentials/);
  });

  it("derives deterministic local task ids without trusting remote ids as paths", () => {
    expect(localTaskId("node-1", "job-123")).toBe(localTaskId("node-1", "job-123"));
    expect(localTaskId("node-1", "job-123")).not.toBe(localTaskId("node-2", "job-123"));
    expect(localTaskId("node-1", "../Downloads")).toMatch(/^t_[a-f0-9]{12}$/);
  });
});
