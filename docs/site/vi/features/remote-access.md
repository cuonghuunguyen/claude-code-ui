# Điện thoại & truy cập từ xa {#phone-remote-access}

Theo mặc định, chỉ máy tính của bạn mới mở được claude-code-ui. Để dùng từ điện thoại hoặc máy tính khác, chọn một cách:

<img src="/screenshots/phone.png" alt="claude-code-ui trên điện thoại" width="300">

| Cách | Dùng được từ | HTTPS (push, cài như ứng dụng) | Thiết lập |
| --- | --- | --- | --- |
| **Tailscale** (khuyến nghị) | Mọi nơi, chỉ các thiết bị của bạn | Có | `--tailscale` |
| **Proxy HTTPS riêng** | Nơi nào truy cập được proxy | Có | `--hostname` |
| **LAN** | Mạng nội bộ của bạn | Không | `--lan` |

## Tailscale {#tailscale}

1. Cài [Tailscale](https://tailscale.com) trên máy tính và điện thoại, rồi đăng nhập trên cả hai.
2. Trong trang quản trị Tailscale (trang DNS), bật **MagicDNS** và **HTTPS certificates**.
3. Khởi động bằng:
   ```sh
   claude-ui --tailscale
   ```
4. Lệnh in ra liên kết `https://<machine>.<tailnet>.ts.net/#token=…` và mã QR. Quét mã bằng điện thoại.

Nếu Tailscale chưa sẵn sàng, claude-ui cho biết còn thiếu gì và thoát.

## Cài như ứng dụng {#install-as-an-app}

Cần HTTPS (Tailscale hoặc proxy riêng của bạn).

- **Chrome trên Android:** menu › **Cài đặt ứng dụng**.
- **iPhone/iPad (iOS 16.4+), Safari:** **Chia sẻ** › **Thêm vào Màn hình chính**. Mở ứng dụng mới, dán liên kết ghép nối mà terminal đã in vào **Liên kết ghép nối hoặc token**, rồi chạm **Ghép nối**.
- **Chrome trên máy tính:** biểu tượng cài đặt ở thanh địa chỉ.

## LAN {#lan}

```sh
claude-ui --lan
```

Lệnh in một liên kết ghép nối cho mỗi địa chỉ cục bộ, ví dụ `http://192.168.1.20:4280/#token=…`.

::: warning HTTP thuần
Bất kỳ ai trong mạng đều đọc được token. Chỉ dùng `--lan` trên mạng bạn tin cậy. Thông báo push, nút Sao chép và việc cài ứng dụng không hoạt động qua HTTP thuần.
:::

## Proxy HTTPS riêng {#your-own-https-proxy}

<details>
<summary>Xem các bước</summary>

Đặt một reverse proxy giữ nguyên header `Host` phía trước `127.0.0.1:4280`, rồi khởi động với tên của proxy:

```sh
claude-ui --hostname my-machine.local
```

Ví dụ với [Caddy](https://caddyserver.com): `caddy reverse-proxy --from my-machine.local --to 127.0.0.1:4280` (tin cậy chứng chỉ cục bộ của Caddy trên điện thoại).

</details>

## Cần biết {#good-to-know}

- **Funnel** công khai của Tailscale không bao giờ được dùng. claude-ui từ chối khởi động nếu Funnel đang bật cho cổng đó.
- `tailscale serve` chỉ chạy khi claude-ui chạy. Không có cấu hình nào còn lại sau khi thoát. Nếu bạn đã thiết lập `tailscale serve --bg 4280`, claude-ui dùng lại cấu hình đó.
- WSL2 mặc định không truy cập được từ LAN. Chạy claude-ui trên Windows, hoặc bật mạng mirrored của WSL.
- Trang tự kết nối lại khi điện thoại thức dậy hoặc mạng trở lại.
- Hãy coi liên kết ghép nối như mật khẩu: nó cấp toàn quyền truy cập. Xem [Quyền riêng tư](../reference/privacy).
