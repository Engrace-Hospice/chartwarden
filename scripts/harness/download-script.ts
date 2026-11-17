/**
 * A script that is downloaded and run on the spot (wave 13 part A, B9: R10-ADV-B9). `curl … | bash`, `bash <(curl …)` and `bash -c "$(curl …)"`
 * ask; `source <(curl -s URL)`, `. <(curl …)` and `eval "$(curl -fsSL URL)"` run the same download and were allowed. Only a DOWNLOADER names the
 * case: `eval "$(ssh-agent -s)"`, `eval "$(direnv hook bash)"` and `source <(kubectl completion bash)` are everyday setup lines and stay allowed. Pure.
 */

/** Programs that fetch bytes from the network. */
const DOWNLOADER = /(?:^|[|;&(]\s*|\s)(?:curl|wget|fetch|http|https|xh|aria2c|nc|ncat|socat)(?=\s|$)/;

/** The reason a download that is run as a script asks. */
export const DOWNLOAD_SCRIPT_REASON =
  "A shell is handed a script that a download produces (`eval \"$(curl …)\"`, `source <(curl …)`), so the guard cannot read what runs. Download it to a file, read it, then run it. A human decides.";

/** Does this command line (the inside of a `$( … )` or a `<( … )`) run a downloader? */
export const downloadsScript = (inner: string): boolean => DOWNLOADER.test(inner.trim());
