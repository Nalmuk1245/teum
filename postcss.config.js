// arb-cockpit does not use Tailwind — this file exists to stop postcss-load-config
// from walking up and picking a parent directory's config (a sibling project's
// ESM tailwind config broke globals.css when this repo sat under another project).
module.exports = { plugins: {} };
