// Quick encryption test to verify hash computation
#include <iostream>
#include <iomanip>
#include <sstream>
#include <vector>
#include <cstring>

#include <mbedtls/md.h>
#include <mbedtls/aes.h>

std::vector<uint8_t> sha256Bytes(const std::string &input) {
    std::vector<uint8_t> digest(32, 0);
    mbedtls_md_context_t ctx;
    mbedtls_md_init(&ctx);
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
    if (!info) return digest;

    if (mbedtls_md_setup(&ctx, info, 0) != 0) {
        mbedtls_md_free(&ctx);
        return digest;
    }

    mbedtls_md_starts(&ctx);
    mbedtls_md_update(&ctx, reinterpret_cast<const unsigned char *>(input.data()), input.size());
    mbedtls_md_finish(&ctx, digest.data());
    mbedtls_md_free(&ctx);
    return digest;
}

std::string toHex(const std::vector<uint8_t> &bytes) {
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (uint8_t byte : bytes) {
        oss << std::setw(2) << static_cast<int>(byte);
    }
    return oss.str();
}

int main() {
    std::string password = "someEncryptionKey123";
    std::string salt = "vdo.ninja";
    std::string streamId = "steve123";

    std::cout << "Testing VDO.Ninja encryption compatibility\n";
    std::cout << "==========================================\n\n";

    std::cout << "Password: '" << password << "'\n";
    std::cout << "Salt: '" << salt << "'\n";
    std::cout << "Stream ID: '" << streamId << "'\n\n";

    // Compute hash suffix for stream ID
    std::string input = password + salt;
    std::cout << "Hash input (password + salt): '" << input << "'\n";

    auto digest = sha256Bytes(input);
    std::cout << "Full SHA256: " << toHex(digest) << "\n";

    // Take first 3 bytes (6 hex chars)
    std::vector<uint8_t> suffix(digest.begin(), digest.begin() + 3);
    std::string hashSuffix = toHex(suffix);

    std::cout << "Hash suffix (first 6 hex chars): " << hashSuffix << "\n";
    std::cout << "Hashed stream ID: " << streamId << hashSuffix << "\n\n";

    // Also compute the encryption key (full SHA256 of password+salt)
    std::cout << "Encryption key (SHA256): " << toHex(digest) << "\n";

    return 0;
}
