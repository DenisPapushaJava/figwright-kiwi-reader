export const waitForWebSocketOpen = (socket, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      callback(value);
    };
    const onOpen = () => finish(resolve);
    const onError = () => finish(reject, new Error('Local Kiwi MCP is unavailable'));
    const onClose = event =>
      finish(
        reject,
        new Error(`Local Kiwi MCP closed before connecting (code ${event.code ?? 'unknown'})`),
      );
    const timer = setTimeout(() => {
      finish(reject, new Error(`Timed out connecting to local Kiwi MCP after ${timeoutMs} ms`));
      socket.close();
    }, timeoutMs);
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
