const BaseController = require('@partFramework/baseController');
const { buildGreeting } = require('./helpers');

// Routing note: this project uses the "controller-package" architecture
// (--architecture default), so routes are declared here with @Route/@HTTP,
// right next to the handler they belong to, instead of a central routes.js.
// If you'd rather have one file listing every route, scaffold with
// --architecture layered --routing file instead.
//
// @Route/@HTTP need the framework's loader to run (it transpiles the
// decorator syntax) — this file can't be `require()`d directly with plain
// Node. See helpers.js and tests/sampleController.test.js for the part of
// this controller that's testable without the framework running, and
// postman/ for exercising the real routes end to end.
class SampleController extends BaseController {

  // ── Response styles ────────────────────────────────────────────────
  // This project only uses plain `return` below. The framework supports
  // several other ways to answer a request — pick whichever fits:
  //
  //   1) return <value>                — what this file does. Simplest case.
  //   2) return Result.ok(<value>)      — the Result wrapper; see
  //      getExample("response") and recipes/send-a-response.md.
  //   3) return new HttpResult(...)     — full control over status code,
  //      headers and content type (e.g. sending a file, a zip, etc.).
  //      See recipes/send-a-response.md.
  //   4) handler(protocolRef, next) {   — Node-style callback instead of
  //        next(err, data);              return. Useful when you can only
  //      }                                answer from inside an async
  //                                       event handler (see httpGetWithNext
  //                                       below). If you accept `next` in
  //                                       the signature, you MUST call it
  //                                       on every path, including success —
  //                                       an unfired `next` leaves the
  //                                       request's internal promise (and
  //                                       its timeout timer) pending, which
  //                                       leaks per request. Prefer plain
  //                                       `return`/`async` unless you
  //                                       genuinely need the callback.
  // ─────────────────────────────────────────────────────────────────────

  @Route('/hello')
  @HTTP('GET')
  httpGet(protocolRef) {
    const name = protocolRef?.request?.queryString?.name;
    return buildGreeting(name);
  }

  // Same idea, showing the next(err, data) form described above.
  // Both `next(null, data)` (success) and `next(error)` (failure) are
  // exercised here on purpose, so nothing is ever left pending.
  @Route('/hello/next')
  @HTTP('GET')
  httpGetWithNext(protocolRef, next) {
    try {
      const name = protocolRef?.request?.queryString?.name;
      next(null, { ...buildGreeting(name), via: 'next' });
    }
    catch (error) {
      next(error);
    }
  }
}

module.exports = {
  controller: SampleController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  )
};
