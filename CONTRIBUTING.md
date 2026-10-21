# Contributing

Thanks for testing Diskoryx. Bug reports and feature requests belong in GitHub Issues. Before filing, search existing issues and include the Diskoryx version, Windows version, clear reproduction steps, expected result, and actual result.

Do not attach scanned documents, disk images, private file names, full paths, or logs containing personal information. Redact usernames, volume labels, and sensitive paths before sharing diagnostic output.

For code changes, keep changes focused, add or update regression tests, and run `npm test`. Windows file-action or packaging changes also need the corresponding Windows checks described in the [technical guide](docs/technical-guide.md). Do not change scanner identity hashes or weaken file-operation validation to make a test pass.
