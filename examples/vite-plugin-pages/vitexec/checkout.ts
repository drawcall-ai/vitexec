import { showVitexecResult } from "../src/main.ts";

const total = [12, 18].reduce((sum, price) => sum + price, 0);
showVitexecResult("checkout.ts", `the checkout total is €${total}`);
