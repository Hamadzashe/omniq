(() => {
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  const header = document.querySelector("[data-header]");
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 12);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  const toggle = document.querySelector(".nav-toggle");
  const menu = document.getElementById("nav-menu");

  if (toggle && menu) {
    const setOpen = (open) => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      menu.classList.toggle("is-open", open);
    };

    toggle.addEventListener("click", () => {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    menu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => setOpen(false));
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
    });
  }

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
