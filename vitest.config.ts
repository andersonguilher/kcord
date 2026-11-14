import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Some server modules open the application database while they are imported. Point that at
    // memory so no test ever touches (or fights over) a real data/kafcord.sqlite.
    env: { KAFCORD_CHAT_DATABASE_PATH: ":memory:" },
  },
});
