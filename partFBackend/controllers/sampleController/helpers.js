// Plain, undecorated helpers — kept separate from main.js on purpose.
// main.js uses @Route/@HTTP class decorators, which need the framework's
// loader to transpile them; a plain `require('./main')` outside the loader
// throws a SyntaxError (native Node doesn't parse this decorator syntax).
// Business logic that should be testable with plain `node --test`, without
// booting the framework, belongs here instead.
exports.buildGreeting = function (name) {
  return { message: `hello ${name || 'world'}` };
};
