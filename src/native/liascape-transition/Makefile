# liascape-transition — wlr-layer-shell + EGL/GLES3 transition renderer for livepaper.
CC      ?= cc
# mpv = libmpv render API → both transition sides decode live (full-live transitions)
PKGS     = wayland-client wayland-egl egl glesv2 mpv
CFLAGS  += -O2 -std=c11 -Wall -Wextra $(shell pkg-config --cflags $(PKGS))
LDFLAGS += $(shell pkg-config --libs $(PKGS)) -lm
SCANNER  = wayland-scanner
PROTODIR = protocol

GEN = xdg-shell-protocol.h xdg-shell-protocol.c \
      wlr-layer-shell-unstable-v1-protocol.h wlr-layer-shell-unstable-v1-protocol.c

PREFIX ?= $(HOME)/.local

liascape-transition: liascape-transition.c $(GEN)
	$(CC) $(CFLAGS) -o $@ liascape-transition.c \
	  xdg-shell-protocol.c wlr-layer-shell-unstable-v1-protocol.c $(LDFLAGS)

%-protocol.h: $(PROTODIR)/%.xml
	$(SCANNER) client-header $< $@
%-protocol.c: $(PROTODIR)/%.xml
	$(SCANNER) private-code $< $@

install: liascape-transition
	install -Dm755 liascape-transition $(DESTDIR)$(PREFIX)/bin/liascape-transition

clean:
	rm -f liascape-transition $(GEN)

.PHONY: install clean
