<p align="center">
A <a href="https://nodejs.org">Node.js</a> framework for building scalable server-side applications
</p>

## Description

partFramework HTTP project — architecture: **controller-package** (default), routing: **decorator** (`@Route`/`@HTTP`).

## Running the app

```bash
npm install
npm start
```

Server listens on `http://localhost:4001` by default (see `project-config/dev/servers.js`).

## What's here

- `controllers/sampleController/` — one controller-package: `main.js` (routing + handlers, via `@Route`/`@HTTP`), `helpers.js` (plain logic, no decorators), `config.js` (behavioral config), `schema.js` (input validation).
- `tests/` — a sample-level test for the undecorated helper. `npm test` to run it. `main.js` itself needs the framework's loader to transpile its decorators, so it isn't required directly in tests — see the comment at the top of `main.js`.
- `postman/` — a Postman collection for the two routes in this sample, to exercise them end to end once the server is running.
- `.partframework.json` — machine-readable manifest of this project's architecture/routing/paths, used by `partFramework create <module>` and by the partFramework MCP server.

## Next steps

- Add a controller: `partFramework create controller <name>`
- Full recipes and API reference: connect an MCP client to the partFramework MCP server (ask your team for the endpoint), or browse the docs site.
