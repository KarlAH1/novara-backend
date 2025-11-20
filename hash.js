import bcryptjs from "bcryptjs";

const run = async () => {
  const password = "HieuInvestor!2025"; // passordet til Hieu
  const hash = await bcryptjs.hash(password, 10);
  console.log("Hash:", hash);
};

run();

