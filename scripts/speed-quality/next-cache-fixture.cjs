// Standalone local fixture reads have no Next request/incremental-cache context.
// Execute the actual database read without framework caching; prohibit writes.
exports.unstable_cache = (read) => read;
exports.revalidateTag = () => { throw new Error("Fixture capture must not invalidate live data."); };
