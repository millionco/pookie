"use client";

import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { useLocalStorage } from "react-use";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import animations from "./animations.module.css";
import { HeaderActions } from "./header-actions";
import { SmilePlusIcon } from "./icons";
import { Mention } from "./mention";
import { MobileSidebarDrawer } from "./mobile-sidebar-drawer";
import { ReactionCountButton } from "./reaction-count-button";
import { cx, panelShadow } from "./styles";

import type EmojiPickerModule from "emoji-picker-react";
import type { EmojiClickData, EmojiStyle, Theme } from "emoji-picker-react";

const EmojiPicker = dynamic(() => import("emoji-picker-react"), {
  ssr: false,
});

let emojiPickerPreloadPromise:
  | Promise<{ default: typeof EmojiPickerModule }>
  | undefined;

const preloadEmojiPicker = () => {
  emojiPickerPreloadPromise ??= import("emoji-picker-react");
  return emojiPickerPreloadPromise;
};

const EMOJI_PICKER_THEME_LIGHT = "light" as Theme;
const EMOJI_PICKER_STYLE_NATIVE = "native" as EmojiStyle;

const REVEAL_ANIMATION_DURATION_MS = 480;
const SCROLL_BUFFER_MS = 150;
const SKIP_HINT_DELAY_MS = 800;

const REVEAL_DELAYS_MS = [0, 500, 1700, 2100, 2400, 3400, 3800, 4100];
const LAST_REVEAL_DELAY_MS = REVEAL_DELAYS_MS[REVEAL_DELAYS_MS.length - 1]!;
const TOTAL_INTRO_DURATION_MS =
  LAST_REVEAL_DELAY_MS + REVEAL_ANIMATION_DURATION_MS;

const MESSAGE_BODY_INDENT_PX = 55;
const messageBodyIndentStyle = { paddingLeft: MESSAGE_BODY_INDENT_PX };
const SCROLL_EDGE_EPSILON_PX = 1;

const ChannelHeader = () => (
  <header className="mb-1.5 flex h-[41px] w-full shrink-0 items-center justify-between gap-3 max-[1040px]:mb-5">
    <div className="flex min-w-0 items-center gap-3">
      <MobileSidebarDrawer activeChannel="pookie" />
      <div className="flex h-[30px] min-w-0 items-center gap-1.5 text-[23px] leading-[30px] font-semibold text-[#393939]">
        <span>#</span>
        <span>pookie</span>
      </div>
    </div>
    <HeaderActions />
  </header>
);

const IntroMessage = ({
  sender,
  body,
  avatar = "default",
  showMention = true,
}: {
  sender: string;
  body: React.ReactNode;
  avatar?: "default" | "pookie";
  showMention?: boolean;
}) => (
  <div className="mb-3 flex min-h-[52px] shrink-0 items-start gap-3 pl-[3px]">
    <div
      aria-hidden="true"
      className={cx(
        "h-10 w-10 shrink-0 rounded-[10px] bg-cover bg-center",
        avatar === "pookie"
          ? "bg-[url(/pookie-avatar.png)]"
          : "bg-[url(/default-pookie-avatar.png)]",
      )}
    />
    <div className="flex min-w-0 flex-col gap-0.5 text-xl leading-[25px] max-[520px]:text-[19px] max-[520px]:leading-6">
      <div className="leading-[inherit] font-bold text-[#1d1c1d]">
        {sender}
      </div>
      <div className="flex flex-wrap items-center gap-[7px] leading-[inherit] font-medium text-[#4d4d4d]">
        {showMention && <Mention name="pookie" />}
        <span>{body}</span>
      </div>
    </div>
  </div>
);

const QuotedSearchResult = ({
  quote,
  source,
}: {
  quote: string;
  source: string;
}) => (
  <div className="mt-1.5" style={messageBodyIndentStyle}>
    <blockquote className="border-l-[3px] border-[#dddddd] py-0.5 pl-3 text-xl leading-[25px] font-medium text-[#4d4d4d] max-[520px]:text-[19px] max-[520px]:leading-6">
      <span className="block">{quote}</span>
      <span className="mt-0.5 block text-base font-semibold text-[#717274] max-[520px]:text-[15px]">
        {source}
      </span>
    </blockquote>
  </div>
);

const EMOJI_PICKER_HEIGHT_PX = 350;
const EMOJI_PICKER_WIDTH_PX = 320;
const PICKER_GAP_PX = 8;

const ReactionPills = () => {
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [reactions, setReactions] = useLocalStorage<string[]>(
    "pookie-reactions",
    [],
  );
  const buttonRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const preloadTimeout = window.setTimeout(() => {
      void preloadEmojiPicker();
    }, 250);

    return () => window.clearTimeout(preloadTimeout);
  }, []);

  const updatePickerPosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPickerPosition({
      top: rect.bottom + PICKER_GAP_PX + window.scrollY,
      left: rect.left + window.scrollX,
    });
  }, []);

  useLayoutEffect(() => {
    if (!isPickerOpen) return;
    updatePickerPosition();
  }, [isPickerOpen, updatePickerPosition]);

  const handleEmojiClick = useCallback(
    (emojiData: EmojiClickData) => {
      setReactions((previous = []) => {
        if (previous.includes(emojiData.emoji)) return previous;
        return [...previous, emojiData.emoji];
      });
      setIsPickerOpen(false);
    },
    [setReactions],
  );

  const handleTogglePicker = useCallback(() => {
    updatePickerPosition();
    void preloadEmojiPicker();
    setIsPickerOpen((wasOpen) => !wasOpen);
  }, [updatePickerPosition]);

  useEffect(() => {
    if (!isPickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        pickerRef.current?.contains(target)
      ) {
        return;
      }
      setIsPickerOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isPickerOpen]);

  return (
    <div
      suppressHydrationWarning
      className="relative mt-2 mb-0 flex min-h-[33px] shrink-0 flex-wrap items-center gap-[9px]"
      style={messageBodyIndentStyle}
    >
      {reactions?.map((emoji) => (
        <ReactionCountButton key={emoji} emoji={emoji} count={1} />
      ))}
      <button
        ref={buttonRef}
        aria-label="Add reaction"
        className="group relative flex h-[33px] w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent bg-[#ededed] hover:border-black/[0.09] hover:bg-white"
        onClick={handleTogglePicker}
        onFocus={() => {
          void preloadEmojiPicker();
        }}
        onPointerEnter={() => {
          void preloadEmojiPicker();
        }}
        type="button"
      >
        <SmilePlusIcon />
      </button>
      {isPickerOpen &&
        createPortal(
          <div
            ref={pickerRef}
            className="fixed z-[9999] [&_.EmojiPickerReact]:rounded-xl! [&_.EmojiPickerReact]:border-[#e8e8e8]! [&_.EmojiPickerReact]:text-base! [&_.EmojiPickerReact]:[box-shadow:#00000008_0px_2px_24px,#00000006_0px_4px_4px,#0000000a_0px_2px_2px]! [&_.EmojiPickerReact]:[--epr-category-label-height:28px]! [&_.EmojiPickerReact]:[--epr-category-navigation-button-size:22px]! [&_.EmojiPickerReact]:[--epr-header-padding:8px_10px_4px]! [&_.EmojiPickerReact_input]:text-base!"
            style={{
              top: pickerPosition.top,
              left: pickerPosition.left,
            }}
          >
            <EmojiPicker
              theme={EMOJI_PICKER_THEME_LIGHT}
              emojiStyle={EMOJI_PICKER_STYLE_NATIVE}
              height={EMOJI_PICKER_HEIGHT_PX}
              width={EMOJI_PICKER_WIDTH_PX}
              onEmojiClick={handleEmojiClick}
              searchPlaceHolder="Search emoji..."
              skinTonesDisabled
              previewConfig={{ showPreview: false }}
              lazyLoadEmojis
            />
          </div>,
          document.body,
        )}
    </div>
  );
};

const MessageBlock = ({
  sender,
  body,
  avatar,
  showMention,
  showReactions = true,
  withBottomGap = true,
  groupedWithPrevious = false,
  revealDelayMs,
  children,
}: {
  sender: string;
  body: React.ReactNode;
  avatar?: "default" | "pookie";
  showMention?: boolean;
  showReactions?: boolean;
  withBottomGap?: boolean;
  groupedWithPrevious?: boolean;
  revealDelayMs?: number;
  children?: React.ReactNode;
}) => (
  <div
    className={cx(
      "-ml-[22px] flex w-[calc(100%+30px)] shrink-0 flex-col pr-2 pl-[22px] hover:bg-black/[0.02] max-[520px]:-ml-4 max-[520px]:w-[calc(100%+32px)] max-[520px]:pr-4 max-[520px]:pl-4",
      groupedWithPrevious ? "py-[2px]" : "py-[10px]",
      withBottomGap && "mb-[6px]",
      revealDelayMs !== undefined && animations.messageReveal,
    )}
    style={
      revealDelayMs !== undefined
        ? { animationDelay: `${revealDelayMs}ms` }
        : undefined
    }
  >
    {groupedWithPrevious ? (
      <div
        className="flex flex-wrap items-center gap-[7px] text-xl leading-[25px] font-medium text-[#4d4d4d] max-[520px]:text-[19px] max-[520px]:leading-6"
        style={messageBodyIndentStyle}
      >
        <span>{body}</span>
      </div>
    ) : (
      <IntroMessage
        sender={sender}
        body={body}
        avatar={avatar}
        showMention={showMention}
      />
    )}
    {children}
    {showReactions && <ReactionPills />}
  </div>
);

const SLACK_ICON_PATH =
  "M27.255 80.719c0 7.33-5.978 13.317-13.309 13.317S.63 88.049.63 80.719s5.987-13.317 13.317-13.317h13.309zm6.709 0c0-7.33 5.987-13.317 13.317-13.317s13.317 5.986 13.317 13.317v33.335c0 7.33-5.986 13.317-13.317 13.317c-7.33 0-13.317-5.987-13.317-13.317zm0 0M47.281 27.255c-7.33 0-13.317-5.978-13.317-13.309S39.951.63 47.281.63s13.317 5.987 13.317 13.317v13.309zm0 6.709c7.33 0 13.317 5.987 13.317 13.317s-5.986 13.317-13.317 13.317H13.946C6.616 60.598.63 54.612.63 47.281c0-7.33 5.987-13.317 13.317-13.317zm0 0M100.745 47.281c0-7.33 5.978-13.317 13.309-13.317s13.317 5.987 13.317 13.317s-5.987 13.317-13.317 13.317h-13.309zm-6.709 0c0 7.33-5.987 13.317-13.317 13.317s-13.317-5.986-13.317-13.317V13.946C67.402 6.616 73.388.63 80.719.63c7.33 0 13.317 5.987 13.317 13.317zm0 0M80.719 100.745c7.33 0 13.317 5.978 13.317 13.309s-5.987 13.317-13.317 13.317s-13.317-5.987-13.317-13.317v-13.309zm0-6.709c-7.33 0-13.317-5.987-13.317-13.317s5.986-13.317 13.317-13.317h33.335c7.33 0 13.317 5.986 13.317 13.317c0 7.33-5.987 13.317-13.317 13.317zm0 0";

export const ChannelPanel = () => {
  const [hasSeenIntro, setHasSeenIntro] = useLocalStorage(
    "pookie-intro-seen",
    false,
  );
  const [didSkip, setDidSkip] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  const [scrollFadeVisibility, setScrollFadeVisibility] = useState({
    top: false,
    bottom: false,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const isIntroComplete = didSkip || (hasMounted && Boolean(hasSeenIntro));

  const updateScrollFadeVisibility = useCallback(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    const maxScrollTop = element.scrollHeight - element.clientHeight;
    const nextVisibility = {
      top: element.scrollTop > SCROLL_EDGE_EPSILON_PX,
      bottom: maxScrollTop - element.scrollTop > SCROLL_EDGE_EPSILON_PX,
    };

    setScrollFadeVisibility((currentVisibility) =>
      currentVisibility.top === nextVisibility.top &&
      currentVisibility.bottom === nextVisibility.bottom
        ? currentVisibility
        : nextVisibility,
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    requestAnimationFrame(updateScrollFadeVisibility);
  }, [updateScrollFadeVisibility]);

  const skipIntro = useCallback(() => {
    setDidSkip(true);
    setHasSeenIntro(true);
    requestAnimationFrame(() => {
      messageEndRef.current?.scrollIntoView({ block: "end" });
    });
  }, [setHasSeenIntro]);

  useEffect(() => {
    if (isIntroComplete || !hasMounted) return;
    const timeout = setTimeout(() => {
      setHasSeenIntro(true);
    }, TOTAL_INTRO_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [isIntroComplete, hasMounted, setHasSeenIntro]);

  useEffect(() => {
    if (isIntroComplete || !hasMounted) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        skipIntro();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isIntroComplete, hasMounted, skipIntro]);

  useEffect(() => {
    if (isIntroComplete || !hasMounted) return;
    const timeouts = REVEAL_DELAYS_MS.map((delay) =>
      setTimeout(scrollToBottom, delay + SCROLL_BUFFER_MS),
    );
    return () => timeouts.forEach(clearTimeout);
  }, [isIntroComplete, hasMounted, scrollToBottom]);

  useLayoutEffect(() => {
    updateScrollFadeVisibility();
  }, [isIntroComplete, updateScrollFadeVisibility]);

  useEffect(() => {
    const element = scrollContainerRef.current;
    if (!element) return;

    updateScrollFadeVisibility();

    const resizeObserver = new ResizeObserver(updateScrollFadeVisibility);
    resizeObserver.observe(element);
    Array.from(element.children).forEach((child) => {
      resizeObserver.observe(child);
    });

    return () => resizeObserver.disconnect();
  }, [updateScrollFadeVisibility]);

  const revealDelay = (delayMs: number) =>
    isIntroComplete ? undefined : delayMs;

  return (
    <div
      className={cx(
        panelShadow,
        "relative flex h-[calc(100svh-clamp(48px,10vh,112px)-165px)] w-[720px] max-w-full flex-[0_0_auto] shrink flex-col overflow-hidden rounded-[18px] bg-white max-[920px]:h-auto max-[920px]:w-full max-[920px]:min-w-0 max-[920px]:basis-auto",
      )}
    >
      <div className="shrink-0 bg-white pt-5 pr-2 pl-[25px] max-[520px]:pr-4 max-[520px]:pl-[19px] max-[520px]:pt-4">
        <ChannelHeader />
      </div>

      <div className="relative min-h-0 flex-1">
        {scrollFadeVisibility.top && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-white to-white/0"
          />
        )}
        {scrollFadeVisibility.bottom && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-12 bg-gradient-to-t from-white to-white/0"
          />
        )}

        <div
          ref={scrollContainerRef}
          onScroll={updateScrollFadeVisibility}
          className="h-full overflow-x-hidden overflow-y-auto pr-2 pl-[22px] [scrollbar-color:rgba(0,0,0,0.15)_transparent] [scrollbar-width:thin] max-[520px]:px-4"
        >
          <MessageBlock
            sender="you"
            body="what'd we ship this week?"
            showReactions={false}
            withBottomGap={false}
          />
          <MessageBlock
            sender="pookie"
            body={
              <>
                looks like <Mention name="nisarg" href="https://x.com/nisargptel" /> shipped the dashboard
                refresh on Tuesday:
              </>
            }
            avatar="pookie"
            showMention={false}
            showReactions
            withBottomGap={false}
            revealDelayMs={revealDelay(REVEAL_DELAYS_MS[1]!)}
          >
            <QuotedSearchResult
              quote="dashboard v2 just shipped 🚢 huge thanks to everyone who reviewed"
              source="@nisarg in #ship-it · 2 days ago"
            />
          </MessageBlock>
          <MessageBlock
            sender="you"
            body="wait who are you"
            showMention={false}
            showReactions={false}
            withBottomGap={false}
            revealDelayMs={revealDelay(REVEAL_DELAYS_MS[2]!)}
          />
          <MessageBlock
            sender="pookie"
            body="i'm pookie 💖"
            avatar="pookie"
            showMention={false}
            showReactions={false}
            withBottomGap={false}
            revealDelayMs={revealDelay(REVEAL_DELAYS_MS[3]!)}
          />
          <MessageBlock
            sender="pookie"
            body="i can search your Slack, generate memes, run code, and connect to your tools (Linear, GitHub, Stripe, anything that speaks MCP)"
            avatar="pookie"
            groupedWithPrevious
            showMention={false}
            showReactions={false}
            withBottomGap={false}
            revealDelayMs={revealDelay(REVEAL_DELAYS_MS[4]!)}
          />
          <MessageBlock
            sender="you"
            body="what do you have access to?"
            showMention={false}
            showReactions={false}
            withBottomGap={false}
            revealDelayMs={revealDelay(REVEAL_DELAYS_MS[5]!)}
          />
          <MessageBlock
            sender="pookie"
            body="fair q. only what you let me see, plus i'm fully open source and self-hostable 🔓 your server, your keys, your data"
            avatar="pookie"
            showMention={false}
            showReactions={false}
            withBottomGap={false}
            revealDelayMs={revealDelay(REVEAL_DELAYS_MS[6]!)}
          />
          <MessageBlock
            sender="pookie"
            body="super easy to set up. the team behind me is tiny, so say hi if you get stuck 👇"
            avatar="pookie"
            groupedWithPrevious
            showMention={false}
            showReactions={false}
            withBottomGap={false}
            revealDelayMs={revealDelay(REVEAL_DELAYS_MS[7]!)}
          >
            <div
              className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2"
              style={messageBodyIndentStyle}
            >
              <a
                className="inline-flex h-[33px] items-center gap-1.5 rounded-[6px] bg-[#007a5a] px-4 text-[14px] leading-none font-semibold text-white no-underline transition-colors hover:bg-[#005e45]"
                href="/api/slack/install"
                rel="noopener noreferrer"
              >
                Install Slack Bot
                <svg
                  aria-hidden="true"
                  className="h-[15px] w-[15px] shrink-0"
                  viewBox="0 0 128 128"
                >
                  <path fill="#fff" d={SLACK_ICON_PATH} />
                </svg>
              </a>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] font-medium text-[#717274]">
                <a
                  className="text-[#006fa8] no-underline hover:underline"
                  href="https://github.com/millionco/pookie"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  github
                </a>
                <span aria-hidden="true">·</span>
                <a
                  className="text-[#006fa8] no-underline hover:underline"
                  href="/docs/quickstart-managed"
                >
                  docs
                </a>
              </div>
            </div>
          </MessageBlock>

          <div ref={messageEndRef} className="h-4 shrink-0" />
        </div>
      </div>

      {!isIntroComplete && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center pb-4">
          <button
            className={cx(
              animations.messageReveal,
              "cursor-pointer rounded-full border-0 bg-white/90 px-3 py-1.5 text-[13px] font-medium text-[#8d8d8d] shadow-sm backdrop-blur-sm transition-colors font-[inherit] hover:bg-white hover:text-[#696969]",
            )}
            onClick={skipIntro}
            style={{ animationDelay: `${SKIP_HINT_DELAY_MS}ms` }}
            type="button"
          >
            press ↵ to skip
          </button>
        </div>
      )}
    </div>
  );
};
