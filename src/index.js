require("dotenv").config();

const app = require("./app");
const { iniciarSyncScheduler } = require("./lib/syncScheduler");

const PORT = process.env.PORT || 3006;

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  iniciarSyncScheduler();
});
