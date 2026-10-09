import type { CDPSession, Page } from "playwright";

export type Cdp = Pick<CDPSession, "send" | "on" | "off"> & {
  wait<T>(operation: Promise<T>): Promise<T>;
  detach(): Promise<void>;
};

/** CDP commands can remain pending after a renderer crash in Chromium. */
export async function openCdp(page: Page): Promise<Cdp> {
  const session = await page.context().newCDPSession(page);
  const browser = page.context().browser();
  const pending = new Set<(error: Error) => void>();
  let failure: Error | undefined;
  const rejectClosed = (error: Error) => {
    failure ??= error;
    for (const reject of pending) reject(failure);
    pending.clear();
    page.off("close", onClose);
    page.off("crash", onCrash);
    browser?.off("disconnected", onDisconnect);
    session.off("close", onSessionClose);
  };
  const onClose = () => rejectClosed(new Error("Page closed; CDP operation interrupted."));
  const onCrash = () => rejectClosed(new Error("Page crashed; CDP operation interrupted."));
  const onDisconnect = () => rejectClosed(new Error("Browser disconnected; CDP operation interrupted."));
  const onSessionClose = () => rejectClosed(new Error("CDP session closed; operation interrupted."));
  page.on("close", onClose);
  page.on("crash", onCrash);
  browser?.on("disconnected", onDisconnect);
  session.on("close", onSessionClose);
  if (page.isClosed()) onClose();
  if (browser && !browser.isConnected()) onDisconnect();

  const wait = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    if (failure) reject(failure);
    else pending.add(reject);
    void operation.then(value => {
      pending.delete(reject);
      resolve(value);
    }, error => {
      pending.delete(reject);
      reject(error);
    });
  });
  const send: CDPSession["send"] = (method, params) => {
    if (failure) return Promise.reject(failure);
    return wait(session.send(method, params));
  };
  return {
    send,
    on: session.on.bind(session),
    off: session.off.bind(session),
    wait,
    async detach() {
      session.off("close", onSessionClose);
      try {
        if (!page.isClosed() && (!browser || browser.isConnected())) await wait(session.detach());
      } finally {
        rejectClosed(new Error("CDP session detached; operation interrupted."));
      }
    }
  };
}
