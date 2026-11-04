(() => {
  const SITE = "https://omniq.co.zw";

  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  const routes = {
    "/": "home",
    "/services": "services",
    "/platforms": "platforms",
    "/process": "process",
    "/about": "about",
    "/sectors": "sectors",
    "/contact": "contact",
  };

  const seo = {
    "/": {
      title: "OMNIQ Integrated Systems | IT, DPO & Digital Solutions Zimbabwe",
      description:
        "OMNIQ Integrated Systems (Private) Limited delivers DPO services, website development, software, cybersecurity, cloud, and healthcare platforms like Poneswa for public and private organisations in Zimbabwe.",
    },
    "/services": {
      title: "Services | DPO, Websites, Software & Digital | OMNIQ",
      description:
        "Explore OMNIQ services: Data Protection Officer support, website development, social media, digital marketing, brand management, document management, printing, software, mobile apps, analytics, and licensing.",
    },
    "/platforms": {
      title: "Poneswa Healthcare Platform | OMNIQ Integrated Systems",
      description:
        "Poneswa is OMNIQ's healthcare platform for reception, nursing, consultations, and patient mobile apps, built for real clinic workflows.",
    },
    "/process": {
      title: "How We Work | OMNIQ Integrated Systems",
      description:
        "OMNIQ's delivery process: understand, design, deliver, and support integrated systems programmes for lasting results.",
    },
    "/about": {
      title: "About OMNIQ Integrated Systems (Private) Limited",
      description:
        "Learn about OMNIQ Integrated Systems (Private) Limited, a Zimbabwe technology firm focused on integrated systems, software, and digital solutions.",
    },
    "/sectors": {
      title: "Who We Serve | Public & Private Sector | OMNIQ",
      description:
        "OMNIQ partners with government, enterprise, and operations-critical organisations that need reliable, accountable technology delivery.",
    },
    "/contact": {
      title: "Contact OMNIQ Integrated Systems",
      description:
        "Contact OMNIQ to discuss DPO services, software projects, websites, platforms, or integrated systems support for your organisation.",
    },
  };

  const header = document.querySelector("[data-header]");
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 12);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const toggle = document.querySelector(".nav-toggle");
  const menu = document.getElementById("nav-menu");

  const setMenuOpen = (open) => {
    if (!toggle || !menu) return;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    menu.classList.toggle("is-open", open);
  };

  if (toggle && menu) {
    toggle.addEventListener("click", () => {
      setMenuOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setMenuOpen(false);
    });
  }

  const getHeaderOffset = () => {
    const sticky = document.querySelector(".site-header");
    return (sticky?.offsetHeight || 72) + 16;
  };

  const normalizePath = (pathname) => {
    if (!pathname || pathname === "/") return "/";
    return pathname.replace(/\/+$/, "") || "/";
  };

  const setMeta = (selector, attr, value) => {
    const el = document.querySelector(selector);
    if (el) el.setAttribute(attr, value);
  };

  const applySeo = (path) => {
    const meta = seo[path] || seo["/"];
    const url = path === "/" ? `${SITE}/` : `${SITE}${path}`;

    document.title = meta.title;
    setMeta('meta[name="description"]', "content", meta.description);
    setMeta('link[rel="canonical"]', "href", url);
    setMeta('meta[property="og:url"]', "content", url);
    setMeta('meta[property="og:title"]', "content", meta.title);
    setMeta('meta[property="og:description"]', "content", meta.description);
    setMeta('meta[name="twitter:title"]', "content", meta.title);
    setMeta('meta[name="twitter:description"]', "content", meta.description);
  };

  const scrollToSection = (id, behavior = "smooth") => {
    if (id === "home") {
      window.scrollTo({ top: 0, behavior });
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    const top = target.getBoundingClientRect().top + window.scrollY - getHeaderOffset();
    window.scrollTo({ top: Math.max(0, top), behavior });
  };

  const applyRoute = (pathname, { push = false, replace = false, scroll = true } = {}) => {
    const path = normalizePath(pathname);
    const id = routes[path] || "home";
    const finalPath = routes[path] ? path : "/";

    if (push) {
      history.pushState({ path: finalPath }, "", finalPath);
    } else if (replace) {
      history.replaceState({ path: finalPath }, "", finalPath);
    }

    applySeo(finalPath);

    document.querySelectorAll(".nav a").forEach((link) => {
      const href = normalizePath(link.getAttribute("href") || "");
      link.classList.toggle("is-active", href === finalPath);
    });

    if (scroll) {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollToSection(id, reduceMotion ? "auto" : "smooth");
    }
  };

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[href]");
    if (!link) return;

    const href = link.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return;
    }

    let url;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return;
    }

    if (url.origin !== window.location.origin) return;

    const path = normalizePath(url.pathname);
    if (!routes[path]) return;

    event.preventDefault();
    setMenuOpen(false);
    applyRoute(path, { push: true, scroll: true });
  });

  window.addEventListener("popstate", () => {
    applyRoute(window.location.pathname, { scroll: true });
  });

  const boot = () => {
    if (window.location.hash) {
      const hash = window.location.hash.replace("#", "");
      const mapped =
        hash === "top" || hash === "home"
          ? "/"
          : hash === "approach"
            ? "/about"
            : routes[`/${hash}`]
              ? `/${hash}`
              : "/";
      applyRoute(mapped, { replace: true, scroll: true });
      return;
    }
    applyRoute(window.location.pathname, { replace: true, scroll: true });
  };

  boot();

  const heroImg = document.querySelector("[data-hero-media] img");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (heroImg && !reduceMotion) {
    let ticking = false;
    window.addEventListener(
      "scroll",
      () => {
        if (ticking) return;
        ticking = true;
        window.requestAnimationFrame(() => {
          const offset = Math.min(window.scrollY * 0.12, 48);
          heroImg.style.transform = `scale(1.02) translate3d(0, ${offset}px, 0)`;
          ticking = false;
        });
      },
      { passive: true }
    );
  }

  const form = document.querySelector(".contact__form");
  const statusEl = document.getElementById("contact-status");

  const setStatus = (message, type) => {
    if (!statusEl) return;
    statusEl.hidden = !message;
    statusEl.textContent = message || "";
    statusEl.classList.remove("is-success", "is-error");
    if (type) statusEl.classList.add(type);
  };

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      if (!button) return;

      const original = button.textContent;
      const payload = {
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        organisation: form.organisation.value.trim(),
        message: form.message.value.trim(),
      };

      if (!payload.name || !payload.email || !payload.message) {
        setStatus("Please complete name, email, and message.", "is-error");
        return;
      }

      button.disabled = true;
      button.textContent = "Sending…";
      setStatus("");

      try {
        const response = await fetch("/api/contact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.ok) {
          throw new Error(data.error || "Unable to send message.");
        }

        form.reset();
        setStatus("Message sent. We will get back to you soon.", "is-success");
        button.textContent = "Sent";
      } catch (error) {
        setStatus(
          error.message || "Something went wrong. Please try again.",
          "is-error"
        );
        button.textContent = original;
      } finally {
        window.setTimeout(() => {
          button.textContent = original;
          button.disabled = false;
        }, 2200);
      }
    });
  }

  if ("IntersectionObserver" in window) {
    const nodes = document.querySelectorAll("[data-reveal]");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    nodes.forEach((node) => observer.observe(node));
  }
})();
