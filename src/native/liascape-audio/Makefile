# liascape-audio — libpulse helper for gapless scene-audio crossfades (event-driven volume).
CC      ?= cc
PKGS     = libpulse
CFLAGS  += -O2 -std=c11 -Wall -Wextra $(shell pkg-config --cflags $(PKGS))
LDFLAGS += $(shell pkg-config --libs $(PKGS)) -lpthread

PREFIX ?= $(HOME)/.local

liascape-audio: liascape-audio.c
	$(CC) $(CFLAGS) -o $@ liascape-audio.c $(LDFLAGS)

install: liascape-audio
	install -Dm755 liascape-audio $(DESTDIR)$(PREFIX)/bin/liascape-audio

clean:
	rm -f liascape-audio

.PHONY: install clean
