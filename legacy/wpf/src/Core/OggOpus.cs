// Ogg/Opus -> 16 kHz mono PCM. Telegram voice notes are this container.
// Decoding goes straight to 16 kHz; Opus can resample internally.

using System.Text;
using Concentus;

namespace ChawoVA.Core;

public static class OggOpus
{
    public static float[] DecodeTo16kMono(byte[] ogg)
    {
        var packets = ReadPackets(ogg);
        if (packets.Count < 2)
            throw new InvalidDataException("ogg/opus file is too short");
        var head = packets[0];
        if (head.Length < 19 || Encoding.ASCII.GetString(head, 0, 8) != "OpusHead")
            throw new InvalidDataException("not an ogg/opus file");

        int preskip48 = head[10] | (head[11] << 8);
        int skip = preskip48 * 16000 / 48000;
        var decoder = OpusCodecFactory.CreateDecoder(16000, 1, null);
        var pcm = new short[1920]; // 120 ms at 16 kHz
        var samples = new List<float>(16000);
        for (int i = 2; i < packets.Count; i++)
        {
            var packet = packets[i];
            if (packet.Length == 0) continue;
            int n = decoder.Decode(packet, pcm, pcm.Length, false);
            for (int s = 0; s < n; s++) samples.Add(pcm[s] / 32768f);
        }
        if (skip > 0 && skip < samples.Count) samples.RemoveRange(0, skip);
        if (samples.Count == 0) throw new InvalidDataException("ogg/opus file had no audio");
        return samples.ToArray();
    }

    private static List<byte[]> ReadPackets(byte[] ogg)
    {
        var packets = new List<byte[]>();
        var partial = new List<byte>(4096);
        int i = 0;
        while (i + 27 <= ogg.Length)
        {
            if (ogg[i] != (byte)'O' || ogg[i + 1] != (byte)'g' || ogg[i + 2] != (byte)'g' || ogg[i + 3] != (byte)'S')
                break;
            int nseg = ogg[i + 26];
            int table = i + 27;
            if (table + nseg > ogg.Length) throw new InvalidDataException("truncated ogg page");
            int pos = table + nseg;
            for (int s = 0; s < nseg; s++)
            {
                int len = ogg[table + s];
                if (pos + len > ogg.Length) throw new InvalidDataException("truncated ogg payload");
                for (int b = 0; b < len; b++) partial.Add(ogg[pos + b]);
                pos += len;
                if (len < 255)
                {
                    packets.Add(partial.ToArray());
                    partial.Clear();
                }
            }
            i = pos;
        }
        if (packets.Count == 0) throw new InvalidDataException("no ogg pages");
        return packets;
    }
}
