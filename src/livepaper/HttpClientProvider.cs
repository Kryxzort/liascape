using System.Net.Http;

namespace livepaper;

public static class HttpClientProvider
{
    public const string UserAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0";

    private static readonly HttpClientHandler _handler = new()
    {
        AutomaticDecompression = System.Net.DecompressionMethods.All
    };

    private static readonly HttpClient _client = new(_handler)
    {
        // Prefer HTTP/2 so parallel page GETs + the details POST multiplex over one connection
        // (fewer TLS handshakes / round-trips). Falls back to 1.1 if a host doesn't support it.
        DefaultRequestVersion = System.Net.HttpVersion.Version20,
        DefaultVersionPolicy = System.Net.Http.HttpVersionPolicy.RequestVersionOrLower,
    };

    public static HttpClient Client => _client;
}
