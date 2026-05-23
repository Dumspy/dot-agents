import { describe, expect, it } from "vitest";
import { htmlToMarkdown, htmlToText, isPoorMarkdownConversion, sanitizeHtml } from "../html.ts";

describe("html pipeline", () => {
	it("removes head and skipped elements without leaking title", () => {
		const input = `
			<html>
				<head><title>TITLE</title><script>bad()</script></head>
				<body>start<script>bad()</script><noscript>fallback</noscript><p>end</p></body>
			</html>
		`;
		expect(htmlToText(input, "https://example.com/page")).toBe("start\n\nend");
		expect(htmlToMarkdown(input, "https://example.com/page")).toBe("start\n\nend");
	});

	it("preserves direct tail text after skipped elements", () => {
		const input = `<html><body>start<script>bad()</script>tail</body></html>`;
		expect(htmlToText(input, "https://example.com/page")).toBe("starttail");
	});

	it("preserves block boundaries", () => {
		const input = `<html><body><div>one</div><div>two</div><p>three <span>four</span></p><p>five</p></body></html>`;
		expect(htmlToText(input, "https://example.com/page")).toBe("one\ntwo\n\nthree four\n\nfive");
	});

	it("absolutizes relative links and images", () => {
		const input = `<html><body><a href="/docs">Docs</a><img src="./image.png"></body></html>`;
		const sanitized = sanitizeHtml(input, "https://example.com/base/index.html");
		expect(sanitized).toMatch(/https:\/\/example\.com\/docs/);
		expect(sanitized).toMatch(/https:\/\/example\.com\/base\/image\.png/);
	});

	it("prefers likely main content over surrounding site chrome", () => {
		const input = `
			<html>
				<body>
					<header><nav><a href="/home">Home</a><a href="/login">Login</a></nav></header>
					<main>
						<article>
							<h1>Article title</h1>
							<p>Useful content.</p>
						</article>
					</main>
					<footer>Footer links</footer>
				</body>
			</html>
		`;
		const sanitized = sanitizeHtml(input, "https://example.com/post");
		expect(sanitized).toMatch(/Article title/);
		expect(sanitized).toMatch(/Useful content\./);
		expect(sanitized).not.toMatch(/Login/);
		expect(sanitized).not.toMatch(/Footer links/);
	});

	it("normalizes heading links that wrap block content", () => {
		const input = `<html><body><a href="/story"><h2>Story title</h2></a></body></html>`;
		expect(htmlToMarkdown(input, "https://example.com/")).toBe("## [Story title](https://example.com/story)");
	});

	it("flattens layout tables instead of returning raw table markup", () => {
		const input = `
			<html>
				<body>
					<div id="bigbox">
						<table><tbody>
							<tr><td>1.</td><td><a href="/item">Item title</a></td></tr>
							<tr><td></td><td>123 points by alice</td></tr>
						</tbody></table>
					</div>
				</body>
			</html>
		`;
		const markdown = htmlToMarkdown(input, "https://news.ycombinator.com/");
		expect(markdown).toMatch(/Item title/);
		expect(markdown).toMatch(/123 points by alice/);
		expect(markdown).not.toMatch(/<table|<tr|<td/i);
		expect(isPoorMarkdownConversion(markdown)).toBe(false);
	});

	it("detects poor markdown conversion", () => {
		expect(isPoorMarkdownConversion("<table><tr><td>raw</td></tr></table>")).toBe(true);
		expect(isPoorMarkdownConversion("# Heading\n\nA clean paragraph.")).toBe(false);
	});
});
