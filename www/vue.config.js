const path = require("path");
const { defineConfig } = require("@vue/cli-service");
const WasmPackPlugin = require("@wasm-tool/wasm-pack-plugin");

module.exports = defineConfig({
    // Relative in production so dist/ works from a subdirectory as well as a domain
    // root; absolute in development because a relative publicPath is not supported by
    // the dev server — Vue CLI uses it verbatim as the URL pathname
    // (@vue/cli-service/lib/commands/serve.js passes it to prepareURLs), which yields
    // malformed asset URLs. Sparrowhawk draws the same line, using './' only for its
    // Electron build.
    publicPath: process.env.NODE_ENV === "production" ? "./" : "/",
    // Flat output, deliberately. With the default `js/` subdirectory a relative
    // publicPath resolves differently in the two contexts that load chunks: the
    // document resolves against dist/, while a worker resolves against its own
    // location in dist/js/ — and since the chunk filename also starts with `js/`, the
    // worker requests dist/js/js/... and 404s. Flattening makes both resolve the same.
    assetsDir: "",
    transpileDependencies: true,
    configureWebpack: {
        // Required because wasm-pack's default `bundler` target is used below: webpack
        // instantiates the module on dynamic import(), so nothing ever calls init().
        experiments: {
            asyncWebAssembly: true,
        },
        devServer: {
            // Rebuilding the wasm on every touch makes HMR unusable, so it is off —
            // the same call sparrowhawk makes.
            hot: false,
            liveReload: false,
            watchFiles: { paths: [] },
        },
    },
    chainWebpack: (config) => {
        config.output
            .filename("[name].[contenthash:8].js")
            .chunkFilename("[name].[contenthash:8].js");

        config
            .plugin("wasm-pack_rammap")
            .use(WasmPackPlugin)
            .init(
                (Plugin) =>
                    new Plugin({
                        crateDirectory: path.resolve(__dirname, "../rust/rammap-bridge"),
                        outDir: path.resolve(__dirname, "./src/pkg_rammap"),
                        forceMode: "production",
                        // No extraArgs. It is tempting to copy `--no-default-features`
                        // from sparrowhawk's deacon block, but that flag would apply to
                        // the *bridge* crate, which has no features — a silent no-op.
                        // Disabling rammap-core's rayon happens on the dependency line
                        // in rust/rammap-bridge/Cargo.toml, the only place it works.
                    })
            )
            .end();

        // *.worker.ts is pulled out of the default js/ts rules and handled by
        // worker-loader, which turns the import into a `new Worker()` factory.
        config.module.rule("js").exclude.add(/\.worker\.(js|ts)$/);
        config.module.rule("ts").exclude.add(/\.worker\.ts$/);
        config.module
            .rule("worker")
            .test(/\.worker\.(js|ts)$/)
            .use("worker-loader")
            .loader("worker-loader")
            .end()
            .use("ts-loader")
            .loader("ts-loader")
            .options({ transpileOnly: true })
            .end();
    },
});
