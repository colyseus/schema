/**
 * Extracted from https://www.npmjs.com/package/strong-events
 */

type FunctionParameters<T extends (...args: any[]) => any> =
  T extends (...args: infer P) => any
    ? P
    : never;

export class EventEmitter<CallbackSignature extends (...args: any[]) => any> {
  handlers: Array<CallbackSignature> = [];

  register(cb: CallbackSignature, once: boolean = false) {
    this.handlers.push(cb);
    return this;
  }

  invoke(...args: FunctionParameters<CallbackSignature>) {
    this.handlers.forEach((handler) => handler(...args));
  }

  invokeAsync(...args: FunctionParameters<CallbackSignature>) {
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
