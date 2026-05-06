import Link from "next/link";

const HtmlAppNotFound = () => (
  <main className="relative flex min-h-svh w-full flex-col items-center justify-center overflow-x-hidden overflow-y-auto bg-[linear-gradient(in_oklab_180deg,oklab(98.6%_0.0006_0.002)_0%,oklab(100%_0_0.0001)_100%)] px-5 py-12 font-sans [font-synthesis:none]">
    <div className="flex max-w-md flex-col items-center gap-4 text-center">
      <span className="text-[64px] font-semibold text-[#e0e0e0]">app gone</span>
      <p className="text-[15px] text-[#999]">
        This Pookie app link is invalid or has expired. Apps are kept for 30
        days, then they vanish. Ask Pookie to make a fresh one.
      </p>
      <Link
        href="/"
        className="inline-flex h-[38px] items-center gap-2 rounded-lg border border-[#d7d7d7] bg-white px-4 text-[14px] leading-none font-semibold text-[#393939] no-underline transition-colors hover:bg-[#f8f8f8]"
      >
        Go home
      </Link>
    </div>
  </main>
);

export default HtmlAppNotFound;
