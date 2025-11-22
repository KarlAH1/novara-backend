import bcryptjs from "bcryptjs";

const run = async () => {
  const password = "Rai$ium2025!Secure#"; // nytt passord til Karl
  const hash = await bcryptjs.hash(password, 10);
  console.log("Hash:", hash);
};

run();
