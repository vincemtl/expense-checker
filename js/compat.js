// Browser compatibility for pdf.js, loaded before it on the page and in its worker (js/pdf-worker.js).
//
//  - Safari (iPhone, iPad, Mac) cannot read a ReadableStream with `for await (... of stream)`. pdf.js does that to
//    read the text of every page (page.getTextContent), so without this every PDF fails on iPhone with
//    "undefined is not a function (near '...t of e...')".
//  - Promise.withResolvers is missing before iOS / Safari 17.4.
// Each addition is only made when the browser does not already have it.

const RS = globalThis.ReadableStream;
if (RS && typeof RS.prototype[Symbol.asyncIterator] !== 'function') {
  // ReadableStream.prototype.values({ preventCancel }), as in the Streams standard
  const values = function values(options = {}) {
    const reader = this.getReader();
    const preventCancel = !!(options && options.preventCancel);
    let finished = false;
    return {
      async next() {
        if (finished) return { done: true, value: undefined };
        try {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            reader.releaseLock();
            return { done: true, value: undefined };
          }
          return { done: false, value };
        } catch (err) {
          finished = true;
          reader.releaseLock();
          throw err;
        }
      },
      async return(value) {
        if (!finished) {
          finished = true;
          try {
            if (!preventCancel) await reader.cancel(value);
          } finally {
            reader.releaseLock();
          }
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  Object.defineProperty(RS.prototype, 'values', { value: values, writable: true, configurable: true });
  Object.defineProperty(RS.prototype, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
}

if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    value: function withResolvers() {
      let resolve;
      let reject;
      const promise = new this((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
    writable: true,
    configurable: true,
  });
}
