# addons plugin

The `write-addon` skill: Claude writes a [claude-ui](https://github.com/cuonghuunguyen/claude-code-ui) addon with the typed addon SDK (`packages/addon-sdk`). Guide: `docs/site/features/addons.md`.

```
claude plugin marketplace add cuonghuunguyen/claude-code-ui
claude plugin install addons@claude-ui
```

Development from a checkout: `claude --plugin-dir plugins/addons`. Validate: `claude plugin validate --strict plugins/addons`.
