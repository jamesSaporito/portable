# Secrets live in the macOS login Keychain as generic passwords under one service name.
# This is the only file that knows where secrets are stored; swap it for another backend later.

PORTABLE_KEYCHAIN_SERVICE="${PORTABLE_KEYCHAIN_SERVICE:-portable}"

# Prints the secret, or nothing (and returns 1) when it isn't stored.
secret_get() {
  security find-generic-password -s "$PORTABLE_KEYCHAIN_SERVICE" -a "$1" -w 2>/dev/null
}

# Prompts for the value so it never appears in argv or shell history. -U replaces an existing item.
secret_set() {
  echo "Enter $1 (input hidden; you'll be asked twice):" >&2
  security add-generic-password -U -s "$PORTABLE_KEYCHAIN_SERVICE" -a "$1" -w
}

secret_delete() {
  security delete-generic-password -s "$PORTABLE_KEYCHAIN_SERVICE" -a "$1" >/dev/null
}
