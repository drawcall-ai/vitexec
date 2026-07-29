import "./style.css";

function requiredElement<T extends Element>(
  selector: string,
  parent: ParentNode = document
): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector} element.`);
  return element;
}

const app = requiredElement<HTMLElement>("#app");

app.innerHTML = `
  <p class="eyebrow">Vite plugin example</p>
  <h1>One app, three normal routes</h1>
  <nav>
    <a href="/">App only</a>
    <a href="/smoke.html">smoke.ts</a>
    <a href="/checkout.html">checkout.ts</a>
  </nav>
  <dl>
    <div>
      <dt>Current route</dt>
      <dd data-route></dd>
    </div>
    <div>
      <dt>Vitexec result</dt>
      <dd data-result data-status="idle">No vitexec script ran on this route.</dd>
    </div>
  </dl>
`;

const route = requiredElement<HTMLElement>("[data-route]", app);
const result = requiredElement<HTMLElement>("[data-result]", app);

route.textContent = location.pathname;

export function showVitexecResult(script: string, message: string): void {
  result.dataset.status = "passed";
  result.textContent = `${script}: ${message}`;
}
