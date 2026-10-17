# DeepSeek Harness Web source

This directory contains unmodified MIT-licensed source from the official [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness), pinned in `manifest.json`. `LICENSE` retains DeepSeek's copyright and permission notice. The source selection includes the three-column frame, sidebar, hero, user-message contents, their relative runtime dependencies, shared icons and brand artwork, and semantic theme sheets. It does not include third-party fonts.

Run `node scripts/vendor-dsh-web.mjs --check` from the repository root to verify the snapshot without network access. `node scripts/vendor-dsh-web.mjs` downloads the pinned selection and refuses to overwrite different source contents. Changing the upstream revision requires an explicit source review and manifest update.

Pi-specific service and presentation adapters belong outside this snapshot. `AppFrame.tsx` depends on DSH slot props, layout stores, React, and theme tokens; the snapshot alone is not a runnable page. The browser profile must provide those inputs or adapt the component before mounting it. Pi Session state remains owned by the existing Pi services.
