require("dotenv").config();

const buildApp = require("./app");

const app = buildApp();

const PORT = Number(process.env.PORT) || 4000;
const HOST = "0.0.0.0";

app.listen({ port: PORT, host: HOST }, (error, address) => {
  if (error) {
    app.log.error(error);
    process.exit(1);
  }

  console.log(`VaultBox API running at ${address}`);
});
