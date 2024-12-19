import { Hono } from "hono";
const app = new Hono();

app.get("/", (c) => {
    setInterval(() => console.error(new Date().toISOString()), 1000);
    return c.text("Hello");
});

export default app;
