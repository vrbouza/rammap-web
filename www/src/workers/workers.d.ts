// worker-loader turns the import into a `new Worker()` factory, so the module's default
// export is a constructor rather than the module itself.
declare module "@/workers/RammapAligner.worker" {
    const WorkerFactory: new () => Worker;
    export default WorkerFactory;
}
