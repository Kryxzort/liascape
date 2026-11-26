using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Liascape.Helpers;

// A write-only stream in front of another that reports how much of `total` bytes has gone through it, so a copy written
// with Stream.CopyToAsync / HttpContent.CopyToAsync shows its progress without a copy loop of its own. Reports nothing
// when the total isn't known (no Content-Length). `max`: the most it lets through; one byte more throws TooLarge (an import
// from a link: a server whose Content-Length lied, or that sent none). Disposing it disposes the inner stream.
public sealed class ProgressStream(Stream inner, long? total, IProgress<double>? progress, long? max = null) : Stream
{
    public sealed class TooLarge(long max) : IOException($"bigger than {max} bytes");

    private long _written;

    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => _written; set => throw new NotSupportedException(); }

    public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

    public override void Write(ReadOnlySpan<byte> buffer)
    {
        Allow(buffer.Length);
        inner.Write(buffer);
        Advance(buffer.Length);
    }

    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) =>
        WriteAsync(buffer.AsMemory(offset, count), ct).AsTask();

    public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default)
    {
        Allow(buffer.Length);
        await inner.WriteAsync(buffer, ct);
        Advance(buffer.Length);
    }

    private void Allow(int n)
    {
        if (max is { } m && _written + n > m) throw new TooLarge(m);
    }

    private void Advance(int n)
    {
        _written += n;
        if (total > 0) progress?.Report((double)_written / total.Value);
    }

    public override void Flush() => inner.Flush();
    public override Task FlushAsync(CancellationToken ct) => inner.FlushAsync(ct);
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await inner.DisposeAsync();
        GC.SuppressFinalize(this);
    }
}
