// Server-rendered page contracts load CSS through Vite without importing
// Next's package-root ambient ProcessEnv augmentation into worker tests.
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
