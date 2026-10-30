---
layout: home
title: claude-code-ui · Giao diện web và GUI cho Claude Code
titleTemplate: false
description: Giao diện web và GUI mã nguồn mở cho Claude Code. Chạy, theo dõi và điều khiển nhiều phiên Claude Code từ trình duyệt hoặc điện thoại. Chạy cục bộ, không đám mây, không telemetry.

hero:
  name: claude-code-ui
  text: Claude Code trong trình duyệt của bạn
  tagline: Chạy, theo dõi và điều khiển nhiều phiên Claude Code từ trình duyệt hoặc điện thoại. Mọi thứ chạy trên máy của bạn.
  actions:
    - theme: brand
      text: Cài đặt trong 30 giây
      link: /vi/guide/install
    - theme: alt
      text: Tham quan nhanh
      link: /vi/guide/tour
    - theme: alt
      text: GitHub
      link: https://github.com/cuonghuunguyen/claude-code-ui

features:
  - title: Nhiều phiên, một màn hình
    details: Các phiên nằm trong tab, nhóm theo dự án. Chúng vẫn chạy khi bạn đóng trình duyệt.
  - title: Cùng quy tắc với Claude Code
    details: Cùng yêu cầu quyền, chế độ, model, lệnh slash, skill và /rewind.
  - title: Trả lời từ mọi nơi
    details: Trang Focus và thông báo đẩy cho thấy việc nào cần bạn, trên mọi dự án.
  - title: Một IDE nhỏ xung quanh
    details: Cây tệp và trình soạn thảo, diff, đồ thị git và terminal thật nằm cạnh khung chat.
  - title: Cả trên điện thoại
    details: Mở qua Tailscale và cài như một ứng dụng trên Android hoặc iOS.
  - title: Riêng tư
    details: Không đám mây, không relay, không telemetry. Mã và cuộc trò chuyện của bạn nằm trên máy bạn.
---

## Cài đặt trong 30 giây {#30-second-install}

Bạn cần Node.js 22+ và Claude Code đã đăng nhập (`claude login`).

```sh
npx claude-code-ui
```

Lệnh in ra một liên kết và mã QR. Mở liên kết là xong. [Chi tiết hơn](/vi/guide/install).

<img class="only-light" src="/screenshots/workspace-light.png" alt="claude-code-ui: dự án và phiên ở bên trái, một phiên ở giữa, bảng thay đổi ở bên phải">
<img class="only-dark" src="/screenshots/workspace-dark.png" alt="claude-code-ui ở chế độ tối">

::: info Không chính thức
claude-code-ui là dự án cộng đồng. Dự án không do Anthropic tạo ra và không liên kết với Anthropic.
:::
