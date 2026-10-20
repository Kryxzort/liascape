# Spike (throwaway): dmabuf worker -> compositor frame sharing.
# Build: env -u LD_LIBRARY_PATH nix develop -c make -C spikes/dmabuf
CC      ?= cc
CFLAGS  += -O2 -g -std=gnu11 -Wall -Wextra -Wno-unused-parameter
SCANNER  = wayland-scanner
PROTODIR = protocol

PROD_PKGS = egl opengl
CONS_PKGS = wayland-client wayland-egl egl opengl

GEN = xdg-shell-protocol.h xdg-shell-protocol.c \
      wlr-layer-shell-unstable-v1-protocol.h wlr-layer-shell-unstable-v1-protocol.c \
      presentation-time-protocol.h presentation-time-protocol.c

all: producer consumer

producer: producer.c common.h
	$(CC) $(CFLAGS) $(shell pkg-config --cflags $(PROD_PKGS)) -o $@ producer.c $(shell pkg-config --libs $(PROD_PKGS))

consumer: consumer.c common.h $(GEN)
	$(CC) $(CFLAGS) $(shell pkg-config --cflags $(CONS_PKGS)) -I. -o $@ consumer.c \
	  xdg-shell-protocol.c wlr-layer-shell-unstable-v1-protocol.c presentation-time-protocol.c \
	  $(shell pkg-config --libs $(CONS_PKGS))

%-protocol.h: $(PROTODIR)/%.xml
	$(SCANNER) client-header $< $@
%-protocol.c: $(PROTODIR)/%.xml
	$(SCANNER) private-code $< $@

clean:
	rm -f producer consumer $(GEN)

.PHONY: all clean
