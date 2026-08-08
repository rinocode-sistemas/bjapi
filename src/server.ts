import express from "express";

const app = express();
const PORT = process.env.PORT || 3006;

app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", message: "bjapi rodando" });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
