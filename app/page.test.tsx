import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Home from "./page";

// The landing page as the server renders it. What it says about the key must
// hold for every wallet Pairy offers: a key on this device, Varial (formerly
// Freighter) and an email or Google wallet held by Privy (O-40).
describe("Home: where your key lives", () => {
  it("names all three wallets and never says every key is made on the device", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain(
      "Your key is never sent to Pairy: it is made on your device, kept in Varial (formerly Freighter), or held by Privy behind your email or Google login.",
    );
    expect(html).not.toContain("Your key is made on your device");
  });

  it("says who asks who you are, which with email or Google is Privy, not Pairy (O-41)", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toContain("You don&#x27;t sign up with Pairy.");
    expect(html).toContain(
      "With a key on your device or Varial, nobody asks who you are. With email or Google, that login goes to Privy; Pairy&#x27;s server knows you only by your Stellar address.",
    );
    // The wallet page reads the login in the browser to show it, so only the server's knowledge is promised (R2-1).
    expect(html).not.toContain("Pairy itself knows you");
    expect(html).not.toContain("Pairy never asks who you are");
    // The card comes after the safety section, so the first mention there names Varial (formerly Freighter) (O-30).
    const first = html.search(/Varial|Freighter/);
    expect(html.slice(first, first + "Varial (formerly Freighter)".length)).toBe("Varial (formerly Freighter)");
  });
});
