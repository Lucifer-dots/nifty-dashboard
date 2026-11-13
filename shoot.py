"""Headless screenshots of every tab (desktop + mobile) plus a setup chart. Usage: .venv/bin/python shoot.py"""
import asyncio, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8787"
TABS = ["pretrade", "flow", "options", "setups", "calm", "screener", "global"]
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome", headless=True)
        errors = []
        for name, vp, mobile in (("desktop", {"width": 1366, "height": 900}, False), ("mobile", {"width": 390, "height": 844}, True)):
            ctx = await b.new_context(viewport=vp, is_mobile=mobile, device_scale_factor=2 if mobile else 1)
            pg = await ctx.new_page()
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
            await pg.goto(BASE + "/", wait_until="networkidle")
            for t in TABS:
                await pg.click(f'nav button[data-tab="{t}"]')
                await pg.wait_for_function(f"document.body.dataset.loaded === '{t}'", timeout=90000)
                await pg.wait_for_timeout(600)
                txt = await pg.inner_text(f"#tab-{t}")
                print(name, t, "UNAVAILABLE" if "DATA UNAVAILABLE" in txt else "ok", len(txt))
                await pg.screenshot(path=f"screenshots/{name}_{t}.png", full_page=not mobile)
            if not mobile:
                await pg.click('nav button[data-tab="setups"]')
                await pg.wait_for_function("document.body.dataset.loaded === 'setups'")
                if await pg.query_selector("#tab-setups .alert"):
                    await pg.click("#tab-setups .alert")
                    await pg.wait_for_selector("#chart canvas", timeout=30000)
                    await pg.wait_for_timeout(1200)
                    await pg.screenshot(path="screenshots/desktop_setup_chart.png")
                    print("chart ok")
            await ctx.close()
        print("JS errors:", errors or "none")
        await b.close()
asyncio.run(main())
