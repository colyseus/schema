/**
 * Extracted from https://www.npmjs.com/package/strong-events
 */

type ExtractFunctionParameters<T extends (...args: any[]) => any> = T extends (...args: infer P) => any ? P : never;

export class EventEmitter_<CallbackSignature extends (...args: any[]) => any> {
  handlers: Array<CallbackSignature> = [];

  register(cb: CallbackSignature, once: boolean = false) {
    this.handlers.push(cb);
    return this;
  }

  invoke(...args: ExtractFunctionParameters<CallbackSignature>) {
    this.handlers.forEach((handler) => handler(...args));
  }

  invokeAsync(...args: ExtractFunctionParameters<CallbackSignature>) {
    return Promise.all(this.handlers.map((handler) => handler(...args)));
  }

  remove (cb: CallbackSignature) {
    const index = this.handlers.indexOf(cb);
    this.handlers[index] = this.handlers[this.handlers.length - 1];
    this.handlers.pop();
  }

  clear() {
    this.handlers = [];
  }
}
