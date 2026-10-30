# Cập nhật {#updates}

claude-code-ui kiểm tra npm để tìm phiên bản mới khi khởi động và mỗi ngày một lần, và có thể tự cập nhật.

## Cách cập nhật từ ứng dụng {#how-to-update-from-the-app}

1. Khi có phiên bản mới, một thông báo hiển thị **Có bản cập nhật**.
2. Bấm **Cập nhật và khởi động lại**. Nó cài phiên bản mới trong khi các phiên của bạn vẫn chạy.
3. Nó khởi động lại khi không còn phiên nào đang làm việc. **Khởi động lại ngay** không chờ: nó kết thúc các lượt đang chạy và đóng các terminal.
4. Trang tự kết nối lại. Các phiên của bạn trở lại.

**Chưa phải bây giờ** ẩn thông báo đến phiên bản kế tiếp.

## Cách cập nhật từ terminal {#how-to-update-from-a-terminal}

```sh
claude-ui update
```

Lần khởi động tiếp theo chạy phiên bản mới.

## Cần biết {#good-to-know}

- Bản cập nhật nằm trong thư mục `versions/` của [thư mục cấu hình](../reference/cli#files). Không cần cài toàn cục và không cần `sudo`. Cũng dùng được khi bạn chạy bằng `npx`.
- `npm i -g claude-code-ui@latest` vẫn dùng được.
- Nếu phiên bản mới không khởi động được, claude-code-ui khởi động phiên bản trước và thông báo việc đó. Để thử lại, xóa `versions/<version>` trong thư mục cấu hình và khởi động lại.
- Bản mã nguồn tải về (`npm start`) không tự cập nhật.
- Tắt việc kiểm tra bằng `--no-update-check`. Dùng bản mirror của registry với `CLAUDE_UI_UPDATE_REGISTRY=https://npm.example.com`.
- Việc kiểm tra chỉ hỏi npm số phiên bản mới nhất. Không có thông tin nào về bạn hay các phiên của bạn được gửi đi.
